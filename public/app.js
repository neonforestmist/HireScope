const form = document.getElementById("analyzeForm");
const githubInput = document.getElementById("githubInput");
const roleInput = document.getElementById("roleInput");
const contextInput = document.getElementById("contextInput");
const contextLinksList = document.getElementById("contextLinksList");
const addContextLinkBtn = document.getElementById("addContextLinkBtn");
const analyzeBtn = document.getElementById("analyzeBtn");

const homeScreen = document.getElementById("homeScreen");
const loadingScreen = document.getElementById("loadingScreen");
const reportScreen = document.getElementById("reportScreen");
const reportSection = document.getElementById("reportSection");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const backBtn = document.getElementById("backBtn");
const loadingCopy = document.getElementById("loadingCopy");

const errorText = document.getElementById("errorText");

const profileAvatar = document.getElementById("profileAvatar");
const profileName = document.getElementById("profileName");
const profileUsername = document.getElementById("profileUsername");
const profileLink = document.getElementById("profileLink");
const profileBio = document.getElementById("profileBio");

const summaryText = document.getElementById("summaryText");
const scoreMethodText = document.getElementById("scoreMethodText");
const chartStatusText = document.getElementById("chartStatusText");
const scoreboard = document.getElementById("scoreboard");
const scoreChartCanvas = document.getElementById("scoreChart");
const roleImpactText = document.getElementById("roleImpactText");
const selectionList = document.getElementById("selectionList");
const evidenceList = document.getElementById("evidenceList");
const externalContextList = document.getElementById("externalContextList");

const strengthsList = document.getElementById("strengthsList");
const gapsList = document.getElementById("gapsList");
const highlightsList = document.getElementById("highlightsList");
const growthList = document.getElementById("growthList");
const repoFindingsList = document.getElementById("repoFindingsList");
const checklistList = document.getElementById("checklistList");

const decisionText = document.getElementById("decisionText");
const reasoningText = document.getElementById("reasoningText");
const recommendationContextText = document.getElementById("recommendationContextText");
const roleFitList = document.getElementById("roleFitList");


let loadingTicker = null;
let loadingMessageIndex = 0;
let scoreChart = null;
const SCREEN_TRANSITION_MS = 260;
let screenTransitionId = 0;
let expandLayoutRaf = null;
let expandLayoutTimeout = null;
let latestAnalysisPayload = null;

const loadingMessages = [
  "Fetching GitHub profile data...",
  "Selecting representative repositories...",
  "Cloning repositories for deterministic checks...",
  "Scoring organization, maturity, and consistency...",
  "Synthesizing report with evidence-backed reasoning...",
];
const MAX_CONTEXT_LINKS = 5;

const scoreLabels = {
  overall: "Overall Senior-level Hiring Readiness",
  codeOrganization: "Architecture & Code Organization",
  projectMaturity: "Execution & Project Maturity",
  consistencyActivity: "Consistency & Ownership",
  codeQuality: "Code Quality & Maintainability",
  projectCompleteness: "Project Completeness & Documentation",
  professionalSignal: "Professional Collaboration Signal",
};

const scoreTableNotes = {
  overall:
    "Weighted combined signal based on architecture quality, project maturity, and delivery consistency.",
  codeOrganization:
    "Measures architecture clarity, readability, testing signals, and maintainability of core repositories.",
  projectMaturity:
    "Reflects production readiness through documentation depth, project completeness, and delivery rigor.",
  consistencyActivity:
    "Captures sustained execution, ownership, and meaningful contribution cadence over time.",
  codeQuality:
    "Proxy view of code quality and maintainability across representative projects.",
  projectCompleteness:
    "Proxy view of shipping discipline, documentation completeness, and project depth.",
  professionalSignal:
    "Proxy view of collaboration and reliability signals from contribution history.",
};

function activeScreenElement() {
  const screens = [homeScreen, loadingScreen, reportScreen];
  const visible = screens.filter((screen) => !screen.classList.contains("hidden"));
  if (visible.length === 0) return null;

  const preferred = visible.find((screen) => !screen.classList.contains("screen-exit"));
  return preferred || visible[0];
}

function cleanupScreenClasses(screen) {
  screen.classList.remove("screen-enter", "screen-enter-active", "screen-exit");
}

function setScreen(screen, options = {}) {
  const { immediate = false } = options;
  const screens = {
    home: homeScreen,
    loading: loadingScreen,
    report: reportScreen,
  };
  const next = screens[screen] || homeScreen;
  const active = activeScreenElement();

  if (immediate || !active || active === next) {
    screenTransitionId += 1;
    [homeScreen, loadingScreen, reportScreen].forEach((item) => {
      cleanupScreenClasses(item);
      item.classList.toggle("hidden", item !== next);
    });
    return;
  }

  const transitionId = ++screenTransitionId;
  [homeScreen, loadingScreen, reportScreen].forEach((item) => {
    if (item !== active && item !== next) {
      cleanupScreenClasses(item);
      item.classList.add("hidden");
    }
  });

  next.classList.remove("hidden");
  cleanupScreenClasses(next);
  next.classList.add("screen-enter");
  void next.offsetWidth;

  requestAnimationFrame(() => {
    if (transitionId !== screenTransitionId) return;
    next.classList.add("screen-enter-active");
    active.classList.add("screen-exit");
  });

  setTimeout(() => {
    if (transitionId !== screenTransitionId) return;
    cleanupScreenClasses(next);
    cleanupScreenClasses(active);
    active.classList.add("hidden");
  }, SCREEN_TRANSITION_MS);
}

function setSubmitState(isSubmitting) {
  analyzeBtn.disabled = isSubmitting;
  if (isSubmitting) {
    analyzeBtn.textContent = "Analyzing...";
    return;
  }

  analyzeBtn.innerHTML = `
    <span class="analyze-btn-label">Analyze</span>
  `;
}

function createContextLinkInput(value = "", options = {}) {
  const { id = null, removable = false } = options;
  const row = document.createElement("div");
  row.className = "context-link-row";

  const input = document.createElement("input");
  input.className = "context-link-url";
  input.name = "contextLinkUrl[]";
  input.type = "url";
  input.placeholder = "https://example.com/profile";
  input.value = value;
  if (id) input.id = id;
  row.appendChild(input);

  if (removable) {
    row.classList.add("has-remove");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "context-link-remove";
    removeBtn.setAttribute("aria-label", "Remove context link");
    removeBtn.title = "Remove link";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      row.remove();
      showError("");
      updateContextLinkControls();
    });
    row.appendChild(removeBtn);
  }

  return row;
}

function contextLinkCount() {
  if (!contextLinksList) return 0;
  return contextLinksList.querySelectorAll(".context-link-url").length;
}

function updateContextLinkControls() {
  const count = contextLinkCount();
  if (addContextLinkBtn) {
    addContextLinkBtn.disabled = count >= MAX_CONTEXT_LINKS;
  }
}

function addContextLinkField(value = "") {
  if (!contextLinksList) return;

  const currentCount = contextLinkCount();
  if (currentCount >= MAX_CONTEXT_LINKS) {
    return;
  }

  showError("");
  contextLinksList.appendChild(createContextLinkInput(value, { removable: true }));
  updateContextLinkControls();
}

function resetContextLinks() {
  if (!contextLinksList) return;
  contextLinksList.innerHTML = "";

  contextLinksList.appendChild(createContextLinkInput("", { id: "contextLinkUrl1" }));
  updateContextLinkControls();
}

function collectContextLinks() {
  if (!contextLinksList) return [];

  const links = [];
  const inputs = Array.from(contextLinksList.querySelectorAll(".context-link-url"));
  if (inputs.length > MAX_CONTEXT_LINKS) {
    throw new Error("Please reduce the number of context links and try again.");
  }

  inputs.forEach((input, index) => {
    const rawValue = input.value.trim();
    if (!rawValue) return;

    try {
      links.push(new URL(rawValue).toString());
    } catch (_error) {
      throw new Error(
        "Please enter a valid URL for context link #" + (index + 1) + " (include https://)."
      );
    }
  });

  return links;
}

function startLoadingTicker() {
  if (!loadingCopy) return;

  stopLoadingTicker();
  loadingMessageIndex = 0;
  loadingCopy.textContent = loadingMessages[loadingMessageIndex];

  loadingTicker = setInterval(() => {
    loadingMessageIndex = (loadingMessageIndex + 1) % loadingMessages.length;
    loadingCopy.textContent = loadingMessages[loadingMessageIndex];
  }, 1300);
}

function stopLoadingTicker() {
  if (loadingTicker) {
    clearInterval(loadingTicker);
    loadingTicker = null;
  }
}

function clearList(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function markdownToHtml(value) {
  const raw = typeof value === "string" ? value.replace(/\r/g, "").trim() : "";
  if (!raw) return "";

  const lines = raw.split("\n");
  const chunks = [];
  let listItems = [];

  function flushList() {
    if (listItems.length === 0) return;
    chunks.push(`<ul>${listItems.join("")}</ul>`);
    listItems = [];
  }

  for (const originalLine of lines) {
    const line = originalLine.trim();

    if (!line) {
      flushList();
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch && bulletMatch[1]) {
      listItems.push(`<li>${formatInlineMarkdown(bulletMatch[1].trim())}</li>`);
      continue;
    }

    flushList();

    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch && headingMatch[1]) {
      chunks.push(`<p><strong>${formatInlineMarkdown(headingMatch[1].trim())}</strong></p>`);
      continue;
    }

    const labeledMatch = line.match(/^([A-Za-z][A-Za-z0-9 &/()'_-]{1,50}):\s*(.+)$/);
    if (labeledMatch && labeledMatch[1] && labeledMatch[2]) {
      chunks.push(
        `<p><span class="md-label">${formatInlineMarkdown(labeledMatch[1].trim())}:</span> ${formatInlineMarkdown(
          labeledMatch[2].trim()
        )}</p>`
      );
      continue;
    }

    chunks.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  flushList();
  return chunks.join("");
}

function setMarkdownContent(element, value, fallback = "No data returned.") {
  if (!element) return;

  const html = markdownToHtml(value);
  if (!html) {
    element.innerHTML = `<p>${escapeHtml(fallback)}</p>`;
    return;
  }

  element.innerHTML = html;
}

function appendListItemContent(element, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const labeledMatch = text.match(/^([A-Za-z][A-Za-z0-9 &/()'_-]{1,50}):\s*(.+)$/);

  if (labeledMatch && labeledMatch[1] && labeledMatch[2]) {
    const label = document.createElement("span");
    label.className = "list-label";
    label.textContent = labeledMatch[1].trim() + ": ";
    element.appendChild(label);
    element.appendChild(document.createTextNode(labeledMatch[2].trim()));
    return;
  }

  element.textContent = text;
}

function renderList(element, items, emptyMessage = "No data returned.") {
  clearList(element);

  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement("li");
    li.textContent = emptyMessage;
    element.appendChild(li);
    return;
  }

  const uniqueItems = [];
  const seen = new Set();

  items.forEach((item) => {
    let serialized = "";
    if (typeof item === "string") {
      serialized = item;
    } else {
      try {
        serialized = JSON.stringify(item);
      } catch (_error) {
        serialized = String(item);
      }
    }

    const key = String(serialized || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    uniqueItems.push(item);
  });

  uniqueItems.forEach((item) => {
    const li = document.createElement("li");
    appendListItemContent(li, item);
    element.appendChild(li);
  });
}

function collapsedHeightForPanel(panel) {
  if (panel.classList.contains("feedback-selection")) return 340;
  if (panel.classList.contains("feedback-evidence")) return 340;
  if (panel.classList.contains("feedback-external")) return 240;
  if (panel.classList.contains("scoreboard-panel")) return 520;
  if (panel.classList.contains("repo-findings-panel")) return 360;
  if (panel.classList.contains("recommendation-panel")) return 430;
  if (panel.classList.contains("checklist-panel")) return 300;
  if (panel.closest(".feedback-grid")) return 300;
  return 280;
}

function clearExpandablePanels() {
  if (!reportSection) return;

  reportSection.querySelectorAll(".expand-btn").forEach((button) => button.remove());
  reportSection.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.remove("is-collapsible", "is-expanded");
    panel.style.removeProperty("--collapsed-height");
  });
}

function applyExpandablePanels() {
  if (!reportSection) return;
  clearExpandablePanels();

  const panels = Array.from(reportSection.querySelectorAll("article.panel")).filter(
    (panel) => !panel.classList.contains("profile-card")
  );

  panels.forEach((panel) => {
    const collapsedHeight = collapsedHeightForPanel(panel);
    panel.style.setProperty("--collapsed-height", `${collapsedHeight}px`);

    const needsExpand = panel.scrollHeight > collapsedHeight + 24;
    if (!needsExpand) {
      panel.style.removeProperty("--collapsed-height");
      return;
    }

    panel.classList.add("is-collapsible");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "expand-btn";
    button.textContent = "Show more";

    button.addEventListener("click", () => {
      const expanded = panel.classList.toggle("is-expanded");
      button.textContent = expanded ? "Show less" : "Show more";
    });

    panel.appendChild(button);
  });
}

function refreshExpandablePanels() {
  if (expandLayoutRaf) cancelAnimationFrame(expandLayoutRaf);
  if (expandLayoutTimeout) clearTimeout(expandLayoutTimeout);

  expandLayoutRaf = requestAnimationFrame(() => {
    applyExpandablePanels();
    expandLayoutTimeout = setTimeout(() => {
      applyExpandablePanels();
      expandLayoutTimeout = null;
    }, 170);
    expandLayoutRaf = null;
  });
}

function scoreClass(value) {
  if (value >= 75) return "good";
  if (value >= 55) return "warn";
  return "low";
}

function formatScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizedScoreEntries(scores = {}) {
  const priorityOrder = [
    "overall",
    "codeOrganization",
    "projectMaturity",
    "consistencyActivity",
    "codeQuality",
    "projectCompleteness",
    "professionalSignal",
  ];

  const seen = new Set();
  const entries = [];

  priorityOrder.forEach((key) => {
    if (seen.has(key)) return;
    if (!Object.prototype.hasOwnProperty.call(scores, key)) return;

    seen.add(key);
    entries.push([key, scores[key]]);
  });

  if (entries.length === 0) {
    return [
      ["overall", 0],
      ["codeOrganization", 0],
      ["projectMaturity", 0],
      ["consistencyActivity", 0],
    ];
  }

  return entries;
}

function renderScoreboard(scores = {}) {
  scoreboard.innerHTML = "";

  normalizedScoreEntries(scores).forEach(([key, rawValue]) => {
    const value = formatScore(rawValue);
    const card = document.createElement("div");
    card.className = "score-item";
    card.innerHTML = `
      <div class="score-head">
        <div class="label">${scoreLabels[key] || key}</div>
        <div class="value ${scoreClass(value)}">${value}<span>/100</span></div>
      </div>
      <div class="score-track">
        <div class="score-fill ${scoreClass(value)}" style="width: ${value}%"></div>
      </div>
    `;
    scoreboard.appendChild(card);
  });
}

function renderScoreChart(scores = {}) {
  if (!scoreChartCanvas) return;

  if (chartStatusText) {
    chartStatusText.classList.add("hidden");
    chartStatusText.textContent = "";
  }

  if (scoreChart) {
    scoreChart.destroy();
    scoreChart = null;
  }

  if (typeof Chart === "undefined") {
    if (chartStatusText) {
      chartStatusText.textContent =
        "Chart unavailable in this browser/network. Numeric score cards are still accurate.";
      chartStatusText.classList.remove("hidden");
    }
    return;
  }

  const values = {
    codeOrganization: formatScore(
      Number.isFinite(scores.codeOrganization) ? scores.codeOrganization : scores.codeQuality
    ),
    projectMaturity: formatScore(
      Number.isFinite(scores.projectMaturity) ? scores.projectMaturity : scores.projectCompleteness
    ),
    consistencyActivity: formatScore(
      Number.isFinite(scores.consistencyActivity)
        ? scores.consistencyActivity
        : scores.professionalSignal
    ),
    overall: formatScore(scores.overall),
  };

  try {
    scoreChart = new Chart(scoreChartCanvas, {
      type: "bar",
      data: {
        labels: [
          "Overall",
          "Architecture & Organization",
          "Project Maturity",
          "Consistency & Ownership",
        ],
        datasets: [
          {
            label: "Score",
            data: [
              values.overall,
              values.codeOrganization,
              values.projectMaturity,
              values.consistencyActivity,
            ],
            backgroundColor: [
              "rgba(255, 149, 88, 0.55)",
              "rgba(255, 88, 114, 0.55)",
              "rgba(255, 199, 112, 0.55)",
              "rgba(255, 116, 150, 0.55)",
            ],
            borderColor: [
              "rgba(255, 149, 88, 1)",
              "rgba(255, 88, 114, 1)",
              "rgba(255, 199, 112, 1)",
              "rgba(255, 116, 150, 1)",
            ],
            borderWidth: 1.8,
            borderRadius: 10,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            min: 0,
            max: 100,
            ticks: {
              color: "rgba(255, 214, 202, 0.82)",
              callback(value) {
                return `${value}`;
              },
            },
            grid: {
              color: "rgba(255, 125, 135, 0.2)",
            },
          },
          y: {
            ticks: {
              color: "rgba(255, 226, 220, 0.95)",
            },
            grid: {
              color: "rgba(255, 125, 135, 0.08)",
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `Score: ${context.parsed.x}/100`;
              },
            },
          },
        },
      },
    });
  } catch (_error) {
    if (chartStatusText) {
      chartStatusText.textContent =
        "Could not render chart cleanly on this device. Numeric score cards are shown above.";
      chartStatusText.classList.remove("hidden");
    }
  }
}

function renderRepoFindings(findings, evidenceRepos = []) {
  clearList(repoFindingsList);

  if (!Array.isArray(findings) || findings.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No repository findings returned.";
    repoFindingsList.appendChild(li);
    return;
  }

  const evidenceByRepo = new Map(
    evidenceRepos.map((entry) => [entry?.repo?.name || "", entry])
  );

  findings.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "repo-finding-item";
    const repoName = entry.repo || "Unknown repo";
    const evidence = evidenceByRepo.get(repoName);

    const rawScore = Number.isFinite(entry.qualityScore)
      ? entry.qualityScore
      : evidence && evidence.scores
        ? evidence.scores.overall
        : "n/a";
    const scoreText = Number.isFinite(rawScore) ? `${formatScore(rawScore)}/100` : "n/a";
    const scoreTone = Number.isFinite(rawScore) ? scoreClass(formatScore(rawScore)) : "na";

    const intent = entry.projectIntent || "Project intent was not clearly identified.";
    const architecture =
      entry.architectureSignal || "Architecture signal was not clearly identified.";
    const risk = entry.risk || "No explicit risk noted.";

    const head = document.createElement("div");
    head.className = "repo-finding-head";

    const repoNameText = document.createElement("strong");
    repoNameText.className = "repo-finding-name";
    repoNameText.textContent = repoName;
    head.appendChild(repoNameText);

    const scoreEl = document.createElement("span");
    scoreEl.className = `repo-finding-score ${scoreTone}`;
    scoreEl.textContent = scoreText;
    head.appendChild(scoreEl);

    const points = document.createElement("ul");
    points.className = "repo-finding-points";

    const intentItem = document.createElement("li");
    intentItem.innerHTML = `<span class="repo-finding-label">Intent:</span> ${escapeHtml(intent)}`;
    points.appendChild(intentItem);

    const architectureItem = document.createElement("li");
    architectureItem.innerHTML = `<span class="repo-finding-label">Architecture:</span> ${escapeHtml(architecture)}`;
    points.appendChild(architectureItem);

    const riskItem = document.createElement("li");
    riskItem.innerHTML = `<span class="repo-finding-label">Risk:</span> ${escapeHtml(risk)}`;
    points.appendChild(riskItem);

    li.appendChild(head);
    li.appendChild(points);
    repoFindingsList.appendChild(li);
  });
}

function renderSelectionRationale(repos = []) {
  const messages = repos.map((entry, index) => {
    const repoName = entry?.repo?.name || "Unknown repo";
    const reason = entry?.selection?.justification || "No rationale returned.";
    const selectionScore = formatScore(entry?.selection?.selectionScore);
    return `#${index + 1} ${repoName} (${selectionScore}/100): ${reason}`;
  });

  renderList(
    selectionList,
    messages,
    "No repository selection rationale was returned."
  );
}

function renderEvidenceSnapshot(repos = []) {
  const items = repos.map((entry) => {
    const repoName = entry?.repo?.name || "Unknown repo";
    const tests = entry?.signals?.tests?.hasTests ? "tests detected" : "no tests detected";
    const readme = entry?.signals?.readme?.present
      ? `README ${entry.signals.readme.length} chars`
      : "README missing";
    const loc = Number.isFinite(entry?.signals?.locEstimate)
      ? `${entry.signals.locEstimate} LOC (est.)`
      : "LOC unavailable";
    const commits = Number.isFinite(entry?.signals?.commitMetrics?.recentCommits90d)
      ? `${entry.signals.commitMetrics.recentCommits90d} commits/90d`
      : "commit activity unavailable";

    return `${repoName}: ${tests}, ${readme}, ${loc}, ${commits}`;
  });

  renderList(evidenceList, items, "No deterministic evidence snapshot was returned.");
}

function renderExternalContext(aiSignals = [], rawContext = []) {
  if (!externalContextList) return;

  const fromAi = Array.isArray(aiSignals) ? aiSignals : [];

  if (fromAi.length > 0) {
    renderList(externalContextList, fromAi, "No external context signals were returned.");
    return;
  }

  const messages = Array.isArray(rawContext)
    ? rawContext.map((entry) => {
        if (!entry || typeof entry !== "object") return "External context entry unavailable.";

        const label = entry.label || "External Link";

        if (!entry.reachable) {
          return label + ": " + (entry.note || "Link could not be fetched.");
        }

        if (entry.restricted) {
          const detail = entry.title || entry.description || "Public details are limited.";
          return label + ": restricted public view. " + detail;
        }

        const detail = entry.title || entry.description || entry.snippet || "Link was fetched successfully.";
        return label + ": " + detail;
      })
    : [];

  renderList(externalContextList, messages, "No external context links were analyzed/presented.");
}

function weightSummary(rolePayload) {
  const weights = rolePayload?.weights;
  if (!weights) return "Deterministic score model was applied.";

  const code = Math.round((weights.codeOrganization || 0) * 100);
  const maturity = Math.round((weights.projectMaturity || 0) * 100);
  const consistency = Math.round((weights.consistencyActivity || 0) * 100);

  return `Senior-engineer weighting (${rolePayload.label || "Role"}): Architecture & Code Organization ${code}% | Execution & Project Maturity ${maturity}% | Consistency & Ownership ${consistency}%`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function asList(value, fallbackMessage) {
  if (!Array.isArray(value) || value.length === 0) {
    return [fallbackMessage];
  }
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function sentenceCount(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  const matches = text.match(/[^.!?]+[.!?]/g);
  if (matches && matches.length > 0) return matches.length;
  return 1;
}

function buildEvaluationModeFallback(rolePayload, report, payload) {
  const modeLabel = rolePayload?.label || rolePayload?.selectedRole || "Recruiter";
  const repos = Array.isArray(payload?.evidence?.repos) ? payload.evidence.repos : [];
  const repoCount = repos.length;
  const reposWithTests = repos.filter((entry) => entry?.signals?.tests?.hasTests).length;

  const languageCounts = {};
  repos.forEach((entry) => {
    const language = normalizeText(entry?.repo?.language);
    if (!language || language.toLowerCase() === "unknown") return;
    languageCounts[language] = (languageCounts[language] || 0) + 1;
  });

  const topLanguages = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([language]) => language);

  const context = normalizeText(payload?.inputContext?.extraContext);
  const overall = formatScore(report?.scores?.overall);

  const sentence1 =
    rolePayload?.impactNote ||
    `${modeLabel} mode applies deterministic weighting across architecture quality, project maturity, and consistency.`;
  const sentence2 =
    repoCount > 0
      ? `This overview is based on ${repoCount} sampled GitHub repositories, with strongest language signals in ${topLanguages.length > 0 ? topLanguages.join(", ") : "mixed stacks"} and tests detected in ${reposWithTests}/${repoCount} repositories.`
      : "No representative repositories were available, so this overview is based on limited GitHub profile evidence.";
  const sentence3 = context
    ? `The context box requested "${context}", and that guidance was used to interpret the repository evidence in this report.`
    : "No context-box instruction was provided, so interpretation stayed anchored to measurable repository evidence only.";
  const sentence4 = `Current deterministic readiness is ${overall}/100, and Evaluation Mode: ${modeLabel} frames how fit is interpreted across the rest of the report.`;

  return [sentence1, sentence2, sentence3, sentence4]
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join(" ");
}

function resolveEvaluationModeIntro(report, rolePayload, payload) {
  const candidate = normalizeText(report?.evaluationModeBlurb);
  if (candidate) {
    const count = sentenceCount(candidate);
    const hasGithubReference = /(github|repository|repositories|repo)/i.test(candidate);
    const context = normalizeText(payload?.inputContext?.extraContext);
    const hasContextReference = /(context|requested|emphasis|focus|priorit|guidance)/i.test(candidate);
    const contextSatisfied = context ? hasContextReference : true;
    if (count >= 3 && count <= 4 && hasGithubReference && contextSatisfied) {
      return candidate;
    }
  }
  return buildEvaluationModeFallback(rolePayload, report, payload);
}

function buildSelectionMessages(repos = []) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return ["No repository selection rationale was returned."];
  }

  return repos.map((entry, index) => {
    const repoName = entry?.repo?.name || "Unknown repo";
    const reason = entry?.selection?.justification || "No rationale returned.";
    const selectionScore = formatScore(entry?.selection?.selectionScore);
    return `#${index + 1} ${repoName} (${selectionScore}/100): ${reason}`;
  });
}

function buildEvidenceMessages(repos = []) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return ["No deterministic evidence snapshot was returned."];
  }

  return repos.map((entry) => {
    const repoName = entry?.repo?.name || "Unknown repo";
    const tests = entry?.signals?.tests?.hasTests ? "tests detected" : "no tests detected";
    const readme = entry?.signals?.readme?.present
      ? `README ${entry.signals.readme.length} chars`
      : "README missing";
    const loc = Number.isFinite(entry?.signals?.locEstimate)
      ? `${entry.signals.locEstimate} LOC (est.)`
      : "LOC unavailable";
    const commits = Number.isFinite(entry?.signals?.commitMetrics?.recentCommits90d)
      ? `${entry.signals.commitMetrics.recentCommits90d} commits/90d`
      : "commit activity unavailable";

    return `${repoName}: ${tests}, ${readme}, ${loc}, ${commits}`;
  });
}

function slugifyFilenamePart(value, fallback) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function downloadReportAsPdf() {
  if (!latestAnalysisPayload) {
    showError("Run an analysis first to export a PDF.");
    return;
  }

  const jsPdfApi = window.jspdf;
  if (!jsPdfApi || typeof jsPdfApi.jsPDF !== "function") {
    showError("PDF export is unavailable in this browser right now.");
    return;
  }

  showError("");

  const { jsPDF } = jsPdfApi;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 44;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const payload = latestAnalysisPayload;
  const report = payload.report || {};
  const recommendation = report.recommendation || {};
  const evidenceRepos = payload.evidence?.repos || [];
  const scores = report.scores || {};
  const profile = payload.profile || {};
  const role = payload.role || {};
  const evaluationModeIntroText = resolveEvaluationModeIntro(report, role, payload);

  function ensureSpace(height = 24) {
    if (y + height <= pageHeight - margin) return;
    doc.addPage();
    y = margin;
  }

  function writeHeading(text, size = 20) {
    ensureSpace(size + 10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(35, 15, 22);
    doc.text(text, margin, y);
    y += size + 8;
  }

  function writeSubheading(text) {
    ensureSpace(24);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(57, 19, 29);
    doc.text(text, margin, y);
    y += 18;
  }

  function writeParagraph(text) {
    const clean = normalizeText(text);
    if (!clean) return;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(45, 29, 33);
    const lines = doc.splitTextToSize(clean, contentWidth);
    ensureSpace(lines.length * 14 + 4);
    doc.text(lines, margin, y);
    y += lines.length * 14 + 6;
  }

  function writeBullets(title, items, fallbackMessage) {
    writeSubheading(title);
    const values = asList(items, fallbackMessage);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(45, 29, 33);

    values.forEach((item) => {
      const lines = doc.splitTextToSize(normalizeText(item), contentWidth - 18);
      ensureSpace(lines.length * 14 + 4);
      doc.text("•", margin + 2, y);
      doc.text(lines, margin + 15, y);
      y += lines.length * 14 + 4;
    });

    y += 4;
  }

  function writeRepoFindings(findings) {
    writeSubheading("Repo-by-Repo Findings");
    if (!Array.isArray(findings) || findings.length === 0) {
      writeParagraph("No repository findings returned.");
      return;
    }

    findings.forEach((entry, index) => {
      const repoName = normalizeText(entry?.repo) || `Repo ${index + 1}`;
      ensureSpace(18);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(45, 19, 29);
      doc.text(`${index + 1}. ${repoName}`, margin, y);
      y += 14;
      doc.setFont("helvetica", "normal");

      const points = [
        `Intent: ${normalizeText(entry?.projectIntent) || "Not clearly identified."}`,
        `Architecture: ${normalizeText(entry?.architectureSignal) || "Not clearly identified."}`,
        `Risk: ${normalizeText(entry?.risk) || "No explicit risk noted."}`,
      ];

      points.forEach((point) => {
        const lines = doc.splitTextToSize(point, contentWidth - 18);
        ensureSpace(lines.length * 14 + 4);
        doc.text("•", margin + 2, y);
        doc.text(lines, margin + 15, y);
        y += lines.length * 14 + 2;
      });

      y += 5;
    });
  }

  function writeScoreTable(values) {
    writeSubheading("Scoreboard:");
    const rows = normalizedScoreEntries(values).map(([key, rawValue]) => [
      scoreLabels[key] || key,
      `${formatScore(rawValue)}/100`,
      scoreTableNotes[key] || "Deterministic evidence-backed hiring signal.",
    ]);

    if (typeof doc.autoTable === "function") {
      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Criterion", "Score", "Interpretation"]],
        body: rows,
        theme: "grid",
        styles: {
          font: "helvetica",
          fontSize: 10,
          cellPadding: 6,
          textColor: [45, 29, 33],
        },
        headStyles: {
          fillColor: [98, 22, 36],
          textColor: [255, 241, 230],
          fontStyle: "bold",
        },
        columnStyles: {
          0: { cellWidth: 170 },
          1: { cellWidth: 72, halign: "center" },
          2: { cellWidth: "auto" },
        },
      });
      y = doc.lastAutoTable.finalY + 14;
      return;
    }

    rows.forEach((row) => writeParagraph(`${row[0]} | ${row[1]} | ${row[2]}`));
    y += 8;
  }

  writeHeading("HireScope Report");
  writeParagraph(
    `${profile.name || profile.username || "Candidate"} (@${profile.username || "-"}) • Generated: ${new Date().toLocaleString()}`
  );
  writeParagraph(payload.profile?.htmlUrl ? `GitHub: ${payload.profile.htmlUrl}` : "");
  y += 8;

  writeHeading("GitHub Feedback", 17);
  writeBullets(
    "Selection Rationale",
    buildSelectionMessages(evidenceRepos),
    "No repository selection rationale was returned."
  );
  writeBullets(
    "Deterministic Evidence",
    buildEvidenceMessages(evidenceRepos),
    "No deterministic evidence snapshot was returned."
  );
  writeBullets(
    "External Context Signals",
    report.externalContextSignals,
    "No external context links were analyzed/presented."
  );
  writeBullets("Strengths", report.strengths, "No strengths returned.");
  writeBullets("Weaknesses", report.gaps, "No weaknesses returned.");
  writeBullets("Technical Highlights", report.technicalHighlights, "No highlights returned.");
  writeBullets("Growth Areas", report.growthAreas, "No growth areas returned.");
  writeRepoFindings(report.repoFindings);

  writeHeading("Hireability", 17);
  writeSubheading("Executive Summary");
  writeParagraph(report.summary || "No executive summary returned.");
  writeScoreTable(scores);
  writeSubheading("Role Impact");
  writeParagraph(report.roleImpact || "No role impact note returned.");
  writeSubheading("Hiring Recommendation");
  writeSubheading("Decision Overview");
  writeParagraph(recommendation.decision || "No recommendation returned.");
  writeSubheading("Assessment Summary");
  writeParagraph(recommendation.reasoning || "No recommendation reasoning returned.");
  writeSubheading("Context-Aware Summary");
  writeParagraph(evaluationModeIntroText || "No context-aware summary returned.");
  writeBullets("Role Fit", recommendation.roleFit, "No role-fit notes returned.");
  writeBullets(
    "Improvement Checklist",
    report.improvementChecklist,
    "No improvement checklist returned."
  );

  const usernamePart = slugifyFilenamePart(profile.username, "candidate");
  const datePart = new Date().toISOString().slice(0, 10);
  doc.save(`hirescope-${usernamePart}-${datePart}.pdf`);
}

function renderProfile(profile) {
  profileAvatar.src = profile.avatarUrl || "";
  profileAvatar.alt = `${profile.username || "GitHub"} avatar`;
  profileName.textContent = profile.name || "Name not provided";
  profileUsername.textContent = `@${profile.username || "-"}`;
  profileLink.href = profile.htmlUrl || "#";
  profileBio.textContent = profile.bio || "No public bio.";
}

function resetReportView() {
  clearExpandablePanels();
  latestAnalysisPayload = null;
  if (downloadPdfBtn) downloadPdfBtn.disabled = true;

  profileAvatar.src = "";
  profileAvatar.alt = "GitHub avatar";
  profileName.textContent = "-";
  profileUsername.textContent = "-";
  profileLink.href = "#";
  profileBio.textContent = "";

  scoreMethodText.textContent = "";
  if (chartStatusText) {
    chartStatusText.classList.add("hidden");
    chartStatusText.textContent = "";
  }
  summaryText.innerHTML = "<p>-</p>";
  roleImpactText.innerHTML = "<p>-</p>";
  scoreboard.innerHTML = "";

  decisionText.textContent = "-";
  reasoningText.innerHTML = "";
  if (recommendationContextText) {
    recommendationContextText.innerHTML = "";
  }

  [
    selectionList,
    evidenceList,
    externalContextList,
    strengthsList,
    gapsList,
    highlightsList,
    growthList,
    repoFindingsList,
    checklistList,
    roleFitList,
  ].forEach(clearList);

  if (scoreChart) {
    scoreChart.destroy();
    scoreChart = null;
  }
}

function showError(message) {
  if (!message) {
    errorText.classList.add("hidden");
    errorText.textContent = "";
    return;
  }

  errorText.textContent = message;
  errorText.classList.remove("hidden");
}

if (addContextLinkBtn) {
  addContextLinkBtn.addEventListener("click", () => addContextLinkField());
}
updateContextLinkControls();

if (downloadPdfBtn) {
  downloadPdfBtn.addEventListener("click", downloadReportAsPdf);
}

window.addEventListener("resize", () => {
  if (reportScreen.classList.contains("hidden")) return;
  refreshExpandablePanels();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  latestAnalysisPayload = null;
  if (downloadPdfBtn) downloadPdfBtn.disabled = true;
  showError("");
  setSubmitState(true);
  setScreen("loading");
  startLoadingTicker();

  try {
    const username = githubInput.value.trim();
    const context = contextInput.value.trim();
    const role = roleInput.value;

    const contextLinks = collectContextLinks();

    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, context, role, contextLinks }),
    });

    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || "Request failed.");
    }
    latestAnalysisPayload = payload;
    if (downloadPdfBtn) downloadPdfBtn.disabled = false;

    const report = payload.report || {};
    const recommendation = report.recommendation || {};
    const evidenceRepos = payload.evidence?.repos || [];
    const rolePayload = payload.role || null;

    renderProfile(payload.profile || {});

    setMarkdownContent(summaryText, report.summary, "No executive summary returned.");
    scoreMethodText.textContent = weightSummary(rolePayload);
    setMarkdownContent(
      roleImpactText,
      report.roleImpact || rolePayload?.impactNote,
      "No role-impact note returned."
    );

    renderScoreboard(report.scores || {});

    renderSelectionRationale(evidenceRepos);
    renderEvidenceSnapshot(evidenceRepos);
    renderExternalContext(report.externalContextSignals, payload.inputContext?.externalContext);

    renderList(strengthsList, report.strengths, "No strengths returned.");
    renderList(gapsList, report.gaps, "No weaknesses returned.");
    renderList(highlightsList, report.technicalHighlights, "No highlights returned.");
    renderList(growthList, report.growthAreas, "No growth areas returned.");
    renderRepoFindings(report.repoFindings, evidenceRepos);
    renderList(checklistList, report.improvementChecklist, "No improvement checklist returned.");
    renderList(roleFitList, recommendation.roleFit, "No role-fit notes returned.");

    decisionText.textContent = recommendation.decision || "No recommendation returned.";
    decisionText.classList.remove("strong", "interview", "not-fit");
    if (/strong hire/i.test(decisionText.textContent)) {
      decisionText.classList.add("strong");
    } else if (/interview/i.test(decisionText.textContent)) {
      decisionText.classList.add("interview");
    } else if (/not a fit/i.test(decisionText.textContent)) {
      decisionText.classList.add("not-fit");
    }
    setMarkdownContent(reasoningText, recommendation.reasoning, "No recommendation reasoning returned.");
    setMarkdownContent(
      recommendationContextText,
      resolveEvaluationModeIntro(report, rolePayload, payload),
      "No context-aware summary returned."
    );

    setScreen("report");
    requestAnimationFrame(() => {
      renderScoreChart(report.scores || {});
      refreshExpandablePanels();
    });
  } catch (error) {
    latestAnalysisPayload = null;
    if (downloadPdfBtn) downloadPdfBtn.disabled = true;
    const message = error instanceof Error ? error.message : "Unknown error";
    showError(message);
    setScreen("home");
  } finally {
    stopLoadingTicker();
    setSubmitState(false);
  }
});

backBtn.addEventListener("click", () => {
  form.reset();
  resetContextLinks();
  resetReportView();
  showError("");
  setScreen("home");
  githubInput.focus();
});
