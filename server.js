// Optional local bridge for Sign in with ChatGPT or the local Claude Code login (Claude plan).
// No third-party packages are needed.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

let claudeConfigured = false;

const host = "127.0.0.1";
const port = Number(process.env.WANNAGOM_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid WANNAGOM_PORT");
const origin = `http://${host}:${port}`;
const redirectUri = `${origin}/auth/callback`;
const resource = "https://api.openai.com/v1";
const tokenEndpoint = "https://auth.openai.com/api/accounts/oauth/token";
const dataDir = path.join(os.homedir(), "Library", "Application Support", "Wannagom");
const dataFile = path.join(dataDir, "account.json");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/src/app.js", ["src/app.js", "text/javascript; charset=utf-8"]],
  ["/src/styles.css", ["src/styles.css", "text/css; charset=utf-8"]]
]);
let account = readAccount();
let pending = null;
let refreshPromise = null;

function readAccount() {
  try { return JSON.parse(fs.readFileSync(dataFile, "utf8")); } catch { return null; }
}

function saveAccount(value) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tempFile, dataFile);
  account = value;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

function formPost(url, fields) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20000)
  });
}

async function jsonOrThrow(response) {
  if (!response.ok) throw new Error(`remote HTTP ${response.status}`);
  return response.json();
}

async function tokenOrThrow(response) {
  if (!response.ok) {
    let code = "unknown";
    try {
      const body = await response.json();
      if (typeof body.error === "string" && /^[a-z_]{1,60}$/.test(body.error)) code = body.error;
    } catch { /* Keep the HTTP status only. */ }
    throw new Error(`token HTTP ${response.status} (${code})`);
  }
  return response.json();
}

async function verifyIdToken(jwt, clientId, nonce) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url"));
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported ID token signature");
  const configuration = await jsonOrThrow(await fetch("https://auth.openai.com/.well-known/openid-configuration", { signal: AbortSignal.timeout(15000) }));
  const jwksUrl = new URL(configuration.jwks_uri);
  if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== "auth.openai.com") throw new Error("Unexpected JWKS endpoint");
  const jwks = await jsonOrThrow(await fetch(jwksUrl, { signal: AbortSignal.timeout(15000) }));
  const key = jwks.keys.find((item) => item.kid === header.kid && item.kty === "RSA");
  if (!key) throw new Error("ID token key unavailable");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!valid || payload.iss !== configuration.issuer || payload.aud !== clientId || payload.nonce !== nonce || !payload.sub || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) {
    throw new Error("ID token validation failed");
  }
  return payload;
}

function beginSignIn(res) {
  const returning = account && account.clientId && account.subject;
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const hostId = account?.hostId || `urn:uuid:${crypto.randomUUID()}`;
  if (!account?.hostId) saveAccount({ hostId });
  pending = { state, nonce, verifier, hostId, started: Date.now(), clientId: returning ? account.clientId : null };
  const query = new URLSearchParams({
    client_id: returning ? account.clientId : "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url")
  });
  if (returning) {
    if (account.idToken) query.set("id_token_hint", account.idToken);
  } else {
    query.set("agent_name_hint", "Wannagom");
  }
  redirect(res, `https://auth.openai.com/api/accounts/authorize?${query}`);
}

async function completeSignIn(url, res) {
  const attempt = pending;
  pending = null;
  if (!attempt || Date.now() - attempt.started > 10 * 60_000 || url.searchParams.get("state") !== attempt.state) {
    return send(res, 400, "로그인 요청이 만료되었어요. 앱으로 돌아가 다시 시도해 주세요.", "text/plain; charset=utf-8");
  }
  if (url.searchParams.has("error")) return redirect(res, "/?login=cancelled");
  const code = url.searchParams.get("code");
  const callbackId = url.searchParams.get("client_id");
  const clientId = attempt.clientId || callbackId;
  if (!code || !clientId || clientId === "dynamic_agent_client" || (attempt.clientId && callbackId && callbackId !== attempt.clientId)) {
    return redirect(res, "/?login=failed");
  }
  try {
    const tokens = await tokenOrThrow(await formPost(tokenEndpoint, {
      grant_type: "authorization_code", client_id: clientId, code,
      code_verifier: attempt.verifier, redirect_uri: redirectUri, resource
    }));
    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) throw new Error("Incomplete token response");
    const identity = await verifyIdToken(tokens.id_token, clientId, attempt.nonce);
    if (attempt.clientId && identity.sub !== account.subject) throw new Error("Account mismatch");
    const scopes = String(tokens.scope || "").split(/\s+/);
    saveAccount({
      hostId: attempt.hostId, clientId, subject: identity.sub,
      email: typeof identity.email === "string" ? identity.email : "",
      idToken: tokens.id_token, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, scopes,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
    });
    redirect(res, "/?login=success");
  } catch (error) {
    console.error("ChatGPT sign-in failed:", error.message);
    redirect(res, "/?login=failed");
  }
}

async function getAccessToken() {
  if (!account?.accessToken || !account.scopes?.includes("chatgpt.tokens.use.direct")) return null;
  if (Date.now() < account.expiresAt - 60_000) return account.accessToken;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const tokens = await tokenOrThrow(await formPost(tokenEndpoint, {
        grant_type: "refresh_token", client_id: account.clientId,
        refresh_token: account.refreshToken, resource
      }));
      if (!tokens.access_token || !tokens.refresh_token) throw new Error("Incomplete refresh response");
      saveAccount({ ...account, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        scopes: String(tokens.scope || account.scopes.join(" ")).split(/\s+/),
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 });
      return account.accessToken;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

const scoreInstructions = "한국어 문장 전체의 문맥을 읽어 집에 가고 싶은 강도를 판단하세요. 부정, 반어, 과장, 유행어, 비속어의 의미를 고려하세요. 기본 점수는 참고값입니다. 반드시 {\"score\":정수,\"factor\":문자열} 형태의 JSON만 출력하세요. score는 0부터 100 사이이고 factor는 피로, 학업, 사람, 부정, 반어, 강조, 기타 중 하나입니다. 사용자에게 보여줄 문장은 작성하지 마세요.";
const scoreFactors = ["피로", "학업", "사람", "부정", "반어", "강조", "기타"];

function validateScore(parsed) {
  if (!Number.isInteger(parsed.score) || parsed.score < 0 || parsed.score > 100) throw new Error("Invalid model score");
  if (!scoreFactors.includes(parsed.factor)) throw new Error("Invalid model factor");
  return { score: parsed.score, factor: parsed.factor };
}

// Claude Code runs with the plan login, so API-key variables must not leak into it.
function claudeEnv() {
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"]) delete env[name];
  return env;
}

function runClaude(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: os.tmpdir(), env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude Code timed out")); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 50000) child.kill();
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Claude Code exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function checkClaude() {
  try {
    await runClaude(["--version"], "", 10000);
    claudeConfigured = true;
  } catch {
    claudeConfigured = false;
  }
}

async function inferScoreWithClaude(text, baseline) {
  const schema = {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      factor: { type: "string", enum: scoreFactors }
    },
    required: ["score", "factor"],
    additionalProperties: false
  };
  const output = await runClaude([
    "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config",
    "--no-session-persistence", "--effort", "low",
    "--system-prompt", scoreInstructions, "--json-schema", JSON.stringify(schema)
  ], JSON.stringify({ sentence: text, baseline }), 60000);
  const result = JSON.parse(output);
  if (result.is_error || !result.structured_output) throw new Error(`Claude Code result ${result.subtype || "invalid"}`);
  return validateScore(result.structured_output);
}

async function inferScore(text, baseline, token) {
  const catalog = await jsonOrThrow(await fetch(`${resource}/models`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000)
  }));
  const model = catalog.models?.find((item) => item.visibility === "list" && typeof item.slug === "string")?.slug;
  if (!model) throw new Error("No eligible model");
  const response = await fetch(`${resource}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, store: false, stream: true,
      instructions: scoreInstructions,
      input: [{ role: "user", content: JSON.stringify({ sentence: text, baseline }) }]
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok || !response.body) throw new Error(`Inference HTTP ${response.status}`);
  let buffer = "";
  let output = "";
  let completed = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    if (buffer.length + output.length > 20000) throw new Error("Inference response too large");
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let item;
      try { item = JSON.parse(data); } catch { continue; }
      if (item.type === "response.output_text.delta") output += item.delta || "";
      if (item.type === "response.completed") {
        completed = true;
        if (!output) output = (item.response?.output || []).flatMap((part) => part.content || []).filter((part) => part.type === "output_text").map((part) => part.text || "").join("");
      }
      if (item.type === "response.failed" || item.type === "response.incomplete") throw new Error(item.type);
    }
  }
  if (!completed) throw new Error("Inference did not complete");
  return validateScore(JSON.parse(output.trim()));
}

const server = http.createServer(async (req, res) => {
  if (req.headers.host !== `${host}:${port}`) return send(res, 403, { error: "Invalid host" });
  const url = new URL(req.url, origin);
  if (req.method === "GET" && staticFiles.has(url.pathname)) {
    const [file, type] = staticFiles.get(url.pathname);
    return send(res, 200, fs.readFileSync(path.join(__dirname, file), "utf8"), type);
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    return send(res, 200, { connected: Boolean(account?.accessToken && account.scopes?.includes("chatgpt.tokens.use.direct")), email: account?.email || "", claude: claudeConfigured });
  }
  if (req.method === "GET" && url.pathname === "/auth/start") return beginSignIn(res);
  if (req.method === "GET" && url.pathname === "/auth/callback") return completeSignIn(url, res);
  if (req.method === "POST" && req.headers.origin !== origin) return send(res, 403, { error: "Invalid origin" });
  if (req.method === "POST" && url.pathname === "/api/analyze") {
    try {
      const body = await readBody(req);
      if (typeof body.text !== "string" || body.text.length > 180 || !body.text.trim() || !Number.isInteger(body.baseline) || body.baseline < 0 || body.baseline > 100) {
        return send(res, 400, { error: "Invalid input" });
      }
      if (body.provider === "claude") {
        if (!claudeConfigured) return send(res, 401, { error: "Claude not configured" });
        return send(res, 200, { ...await inferScoreWithClaude(body.text, body.baseline), provider: "claude" });
      }
      if (body.provider !== "chatgpt") return send(res, 400, { error: "Invalid provider" });
      const token = await getAccessToken();
      if (!token) return send(res, 401, { error: "AI not connected" });
      return send(res, 200, { ...await inferScore(body.text, body.baseline, token), provider: "chatgpt" });
    } catch (error) {
      console.error("AI score fallback:", error.message);
      return send(res, 503, { error: "AI unavailable" });
    }
  }
  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const previous = account;
    let revoked = true;
    if (previous) {
      saveAccount({ hostId: previous.hostId, clientId: previous.clientId, subject: previous.subject });
      if (previous.refreshToken) {
        try {
          const config = await jsonOrThrow(await fetch("https://auth.openai.com/.well-known/openid-configuration", { signal: AbortSignal.timeout(15000) }));
          const endpoint = new URL(config.revocation_endpoint);
          if (endpoint.protocol === "https:" && endpoint.hostname === "auth.openai.com") {
            const response = await formPost(endpoint, { token: previous.refreshToken, token_type_hint: "refresh_token", client_id: previous.clientId });
            if (!response.ok) revoked = false;
          } else {
            revoked = false;
          }
        } catch (error) { revoked = false; console.error("Remote revocation unconfirmed:", error.message); }
      }
    }
    return send(res, 200, { connected: false, revoked });
  }
  return send(res, 404, { error: "Not found" });
});

server.listen(port, host, async () => {
  console.log(`워나곰: ${origin}`);
  await checkClaude();
  console.log(claudeConfigured
    ? "Claude 문맥 보정 사용: Claude Code 로그인(내 플랜)"
    : "Claude를 쓰려면 Claude Code를 설치하고 로그인한 뒤 서버를 다시 시작하세요.");
});
