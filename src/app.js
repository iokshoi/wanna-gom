const inputScreen = document.getElementById("input-screen");
const loadingScreen = document.getElementById("loading-screen");
const resultScreen = document.getElementById("result-screen");
const feelingForm = document.getElementById("feeling-form");
const feelingInput = document.getElementById("feeling-input");
const formError = document.getElementById("form-error");
const fieldHint = document.getElementById("field-hint");
const charCount = document.getElementById("char-count");
const displayScore = document.getElementById("display-score");
const scoreMeter = document.getElementById("score-meter");
const scoreLabel = document.getElementById("score-label");
const scoreReason = document.getElementById("score-reason");
const recommendationIcon = document.getElementById("recommendation-icon");
const recommendationTitle = document.getElementById("recommendation-title");
const recommendationDetail = document.getElementById("recommendation-detail");
const retryButton = document.getElementById("retry-button");
const calculateButton = document.getElementById("calculate-button");
const scoreNote = document.getElementById("score-note");
const aiConnect = document.getElementById("ai-connect");
const aiStatus = document.getElementById("ai-status");
const aiLogin = document.getElementById("ai-login");
const aiLogout = document.getElementById("ai-logout");

const numberFormatter = new Intl.NumberFormat("ko-KR");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let loadingTimer = null;
let scoreAnimation = null;
const providerInputs = document.querySelectorAll('input[name="ai-provider"]');
let aiConnected = false;
let aiStatusData = null;
const localAiServer = location.protocol === "http:" && location.hostname === "127.0.0.1";

function getSelectedProvider() {
  return document.querySelector('input[name="ai-provider"]:checked')?.value || "chatgpt";
}

function renderAiStatus() {
  const provider = getSelectedProvider();
  if (!aiStatusData) {
    aiConnected = false;
    aiStatus.textContent = "AI 연결 상태를 확인할 수 없어 기본 점수로 계산해요.";
    aiLogin.hidden = provider !== "chatgpt";
    aiLogout.hidden = true;
    fieldHint.textContent = "집 생각, 피로, 수업이나 과제처럼 적어줘. Enter로 결과 보기 · Shift+Enter로 줄바꿈";
    return;
  }
  const chatgptConnected = aiStatusData.connected === true;
  if (provider === "claude") {
    aiConnected = aiStatusData.claude === true;
    aiStatus.textContent = aiConnected
      ? "Claude 연결됨 (내 플랜 · Claude Code). 입력 문장을 Claude로 보정해요. 계산에 몇 초 더 걸릴 수 있어요."
      : "Claude Code를 찾지 못했어요. Claude Code를 설치하고 로그인한 뒤 서버를 다시 시작해 주세요. 지금은 기본 점수로 계산해요.";
    aiLogin.hidden = true;
    aiLogout.hidden = true;
    fieldHint.textContent = aiConnected
      ? "떠오르는 말을 자유롭게 적어줘. Enter로 결과 보기 · Shift+Enter로 줄바꿈"
      : "집 생각, 피로, 수업이나 과제처럼 적어줘. Enter로 결과 보기 · Shift+Enter로 줄바꿈";
    return;
  }
  aiConnected = chatgptConnected;
  aiStatus.textContent = chatgptConnected
    ? `ChatGPT 연결됨${aiStatusData.email ? ` · ${aiStatusData.email}` : ""}. 입력 문장을 ChatGPT로 보정해요.`
    : "연결하면 ChatGPT 플랜으로 문맥을 보정해요. 연결 전에는 기본 점수로 계산해요.";
  aiLogin.hidden = chatgptConnected;
  aiLogout.hidden = !chatgptConnected;
  fieldHint.textContent = aiConnected
    ? "떠오르는 말을 자유롭게 적어줘. Enter로 결과 보기 · Shift+Enter로 줄바꿈"
    : "집 생각, 피로, 수업이나 과제처럼 적어줘. Enter로 결과 보기 · Shift+Enter로 줄바꿈";
  if (!chatgptConnected && new URLSearchParams(location.search).get("login") === "failed") {
    aiStatus.textContent = "ChatGPT 연결을 마치지 못했어요. 다시 눌러 시도해 주세요. 기본 점수는 계속 사용할 수 있어요.";
  }
}

async function refreshAiStatus() {
  if (!localAiServer) return;
  aiConnect.hidden = false;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    aiStatusData = await response.json();
  } catch {
    aiStatusData = null;
  }
  renderAiStatus();
}

try {
  const savedProvider = localStorage.getItem("wannagomAiProvider");
  providerInputs.forEach((input) => { if (input.value === savedProvider) input.checked = true; });
} catch { /* Default selection stays ChatGPT. */ }

providerInputs.forEach((input) => {
  input.addEventListener("change", () => {
    try { localStorage.setItem("wannagomAiProvider", getSelectedProvider()); } catch { /* Selection still works for this visit. */ }
    renderAiStatus();
  });
});

function normalizeText(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[.,!?~…]/g, "");
}

function containsAny(text, expressions) {
  return expressions.some((expression) => text.includes(expression));
}

function getRecommendation(score, signals) {
  if (score >= 80) {
    return {
      icon: "🛋️",
      title: "오늘은 충전이 먼저!",
      detail: "가능할 때 잠깐 쉬고, 집에서는 좋아하는 음악과 함께 숨을 돌려봐."
    };
  }

  if (signals.hungry && score >= 40) {
    return {
      icon: "🌶️",
      title: "엽떡 같은 맛있는 한 끼",
      detail: "오늘 할 일을 마친 뒤 좋아하는 메뉴로 기분을 달래보는 건 어때?"
    };
  }

  if (signals.tired) {
    return {
      icon: "🥤",
      title: "간식 먹고 잠깐 쉬기",
      detail: "물 한 잔과 작은 간식으로 에너지를 채우고 다음 일을 시작해봐."
    };
  }

  if (signals.pressure) {
    return {
      icon: "🎧",
      title: "좋아하는 노래 한 곡",
      detail: "할 일을 잠시 내려놓고 노래 한 곡만큼 가볍게 쉬어가자."
    };
  }

  if (score <= 25) {
    return {
      icon: "✨",
      title: "오늘의 좋은 순간 기록하기",
      detail: "괜찮았던 순간 하나를 적어두면 나중에 다시 꺼내 보기 좋아."
    };
  }

  return {
    icon: "🍡",
    title: "작은 간식으로 기분 전환",
    detail: "오늘의 나에게 좋아하는 간식 하나를 선물해봐."
  };
}

function getScoreLabel(score) {
  if (score <= 20) return "집 생각은 잠깐 ✦";
  if (score <= 40) return "슬슬 집 생각 중";
  if (score <= 65) return "집이 나를 부른다";
  if (score <= 85) return "귀가 레이더 ON";
  return "오늘은 쉬어야겠곰";
}

function getScoreReason(signals) {
  if (signals.negatedHome) return "집에 가고 싶은 마음은 낮게 읽혔어요.";
  if (signals.tired && signals.pressure) return "피로와 할 일이 함께 느껴져 점수가 올라갔어요.";
  if (signals.tired) return "지친 마음이 느껴져 집 생각이 커진 것 같아요.";
  if (signals.pressure) return "학교나 할 일 때문에 집 생각이 난 것 같아요.";
  if (signals.urgent) return "당장 집에 가고 싶은 마음이 강하게 느껴져요.";
  if (signals.positive) return "오늘은 비교적 괜찮은 기분으로 읽혔어요.";
  return "집에 가고 싶은 마음을 문장에서 찾았어요.";
}

const aiReasons = {
  "피로": "지친 기분이 문장 전체에서 느껴져 점수에 반영했어요.",
  "학업": "수업이나 할 일에서 오는 부담을 점수에 반영했어요.",
  "사람": "사람들과 보내며 쌓인 피로감을 점수에 반영했어요.",
  "부정": "집에 가고 싶지 않다는 뜻을 읽고 점수를 조정했어요.",
  "반어": "말의 겉뜻과 다른 뉘앙스를 읽고 점수를 조정했어요.",
  "강조": "강하게 표현한 마음을 점수에 반영했어요.",
  "기타": "문장 전체의 뜻을 읽고 점수를 정했어요."
};

function assessFeeling(text) {
  const normalized = normalizeText(text);
  const signals = {
    negatedHome: containsAny(normalized, ["집가고싶지않", "집에가고싶지않", "집안가고싶", "집에안가고싶", "집가기싫", "집에가기싫", "집생각안나", "집생각별로안나"]),
    home: containsAny(normalized, ["집가고싶", "집에가고싶", "집가고파", "집보내", "집에보내", "집으로가고싶", "하교하고싶", "퇴근하고싶"]),
    tired: containsAny(normalized, ["피곤", "지쳤", "지침", "졸려", "졸립", "방전", "기빨", "녹초", "힘들", "무기력", "현타", "멘붕"]),
    pressure: containsAny(normalized, ["시험", "과제", "수업", "야자", "학원", "팀플", "발표", "공부", "학교", "알바"]),
    hungry: containsAny(normalized, ["배고", "먹고싶", "떡볶이", "간식"]),
    urgent: containsAny(normalized, ["너무", "진짜", "완전", "엄청", "제발", "당장", "지금바로", "못버티겠"]),
    positive: containsAny(normalized, ["괜찮", "버틸만", "재밌", "즐겁", "신나", "좋아"])
  };

  const hasMoodSignal = signals.negatedHome || signals.home || signals.tired || signals.pressure || signals.positive;
  if (!hasMoodSignal) return null;

  let score = signals.home ? 45 : 22;
  if (signals.tired) score += 18;
  if (signals.pressure) score += 12;
  if (signals.urgent) score += 16;
  if (signals.positive) score -= 18;
  if (signals.negatedHome) score = signals.tired ? 16 : 8;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    label: getScoreLabel(score),
    reason: getScoreReason(signals),
    recommendation: getRecommendation(score, signals)
  };
}

function showScreen(screen) {
  inputScreen.hidden = screen !== inputScreen;
  loadingScreen.hidden = screen !== loadingScreen;
  resultScreen.hidden = screen !== resultScreen;
}

function clearError() {
  formError.textContent = "";
  formError.hidden = true;
  feelingInput.removeAttribute("aria-invalid");
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
  feelingInput.setAttribute("aria-invalid", "true");
  feelingInput.focus();
}

function animateScore(target) {
  if (scoreAnimation !== null) cancelAnimationFrame(scoreAnimation);
  const endValue = target * 10000;
  const duration = reducedMotion.matches ? 0 : 1100;
  const start = performance.now();

  function frame(now) {
    const progress = duration === 0 ? 1 : Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    displayScore.textContent = numberFormatter.format(Math.round(endValue * eased));
    scoreMeter.style.width = `${target * eased}%`;

    if (progress < 1) {
      scoreAnimation = requestAnimationFrame(frame);
    } else {
      displayScore.setAttribute("aria-label", `${numberFormatter.format(endValue)}점`);
      scoreAnimation = null;
    }
  }

  scoreAnimation = requestAnimationFrame(frame);
}

const aiProviderNames = { claude: "Claude", chatgpt: "ChatGPT" };

function renderResult(result, source = "dictionary", factor = "기타", provider = "chatgpt") {
  scoreLabel.textContent = getScoreLabel(result.score);
  scoreReason.textContent = source === "ai"
    ? aiReasons[factor]
    : result.reason;
  recommendationIcon.textContent = result.recommendation.icon;
  recommendationTitle.textContent = result.recommendation.title;
  recommendationDetail.textContent = result.recommendation.detail;
  scoreNote.textContent = source === "ai"
    ? `${aiProviderNames[provider]}로 문맥을 보정한 놀이용 점수예요.`
    : aiConnected ? "AI 연결에 실패해 사전 규칙의 기본 점수로 계산했어요." : "사전 규칙으로 계산한 놀이용 점수예요.";
  displayScore.textContent = "0";
  displayScore.setAttribute("aria-label", "0점");
  scoreMeter.style.width = "0%";
  showScreen(resultScreen);
  animateScore(result.score);
}

feelingInput.addEventListener("input", () => {
  charCount.textContent = `${feelingInput.value.length} / 180`;
  clearError();
});

feelingInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || calculateButton.disabled) return;
  event.preventDefault();
  feelingForm.requestSubmit();
});

document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => {
    feelingInput.value = button.dataset.example;
    charCount.textContent = `${feelingInput.value.length} / 180`;
    clearError();
    feelingInput.focus();
  });
});

feelingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const text = feelingInput.value.trim();
  if (!text) {
    showError("지금 기분을 한 줄 적어줘!");
    return;
  }

  const result = assessFeeling(text);
  if (!result && !aiConnected) {
    showError("집 생각이나 피로, 수업처럼 지금 느낌을 조금 더 구체적으로 적어줘.");
    return;
  }

  showScreen(loadingScreen);
  calculateButton.disabled = true;
  const start = performance.now();
  let finalResult = result;
  let source = "dictionary";
  let factor = "기타";
  let provider = "chatgpt";
  if (aiConnected) {
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, baseline: result?.score ?? null, provider: getSelectedProvider() })
      });
      if (!response.ok) throw new Error("AI unavailable");
      const data = await response.json();
      if (!Number.isInteger(data.score) || data.score < 0 || data.score > 100) throw new Error("Invalid score");
      if (!Object.hasOwn(aiReasons, data.factor)) throw new Error("Invalid factor");
      finalResult = { ...result, score: data.score, recommendation: getRecommendation(data.score, {
        hungry: containsAny(normalizeText(text), ["배고", "먹고싶", "떡볶이", "간식"]),
        tired: containsAny(normalizeText(text), ["피곤", "지쳤", "방전", "힘들"]),
        pressure: containsAny(normalizeText(text), ["시험", "과제", "수업", "학교", "알바"])
      }) };
      source = "ai";
      factor = data.factor;
      if (Object.hasOwn(aiProviderNames, data.provider)) provider = data.provider;
    } catch {
      if (!result) {
        calculateButton.disabled = false;
        showScreen(inputScreen);
        showError("AI 분석을 완료하지 못했어요. 다시 시도하거나 집 생각처럼 기분을 조금 더 적어줘.");
        return;
      }
    }
  }
  const remaining = Math.max(0, (reducedMotion.matches ? 250 : 950) - (performance.now() - start));
  loadingTimer = window.setTimeout(() => {
    loadingTimer = null;
    calculateButton.disabled = false;
    renderResult(finalResult, source, factor, provider);
  }, remaining);
});

aiLogout.addEventListener("click", async () => {
  aiLogout.disabled = true;
  let revocationUnconfirmed = false;
  try {
    const response = await fetch("/auth/logout", { method: "POST" });
    if (response.ok) revocationUnconfirmed = (await response.json()).revoked === false;
  } catch { /* status will show the current state */ }
  aiLogout.disabled = false;
  await refreshAiStatus();
  if (revocationUnconfirmed) aiStatus.textContent = "로컬 연결을 해제했어요. 원격 해제는 확인되지 않아 ChatGPT 설정에서도 연결을 확인해 주세요.";
});

retryButton.addEventListener("click", () => {
  if (loadingTimer !== null) clearTimeout(loadingTimer);
  if (scoreAnimation !== null) cancelAnimationFrame(scoreAnimation);
  loadingTimer = null;
  scoreAnimation = null;
  calculateButton.disabled = false;
  feelingForm.reset();
  charCount.textContent = "0 / 180";
  clearError();
  showScreen(inputScreen);
  feelingInput.focus();
});

refreshAiStatus();
