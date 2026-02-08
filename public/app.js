const form = document.getElementById("analyzeForm");
const githubInput = document.getElementById("githubInput");
const roleInput = document.getElementById("roleInput");
const otherRoleWrap = document.getElementById("otherRoleWrap");
const otherRoleInput = document.getElementById("otherRoleInput");
const contextInput = document.getElementById("contextInput");
const contextLinksList = document.getElementById("contextLinksList");
const addContextLinkBtn = document.getElementById("addContextLinkBtn");
const analyzeBtn = document.getElementById("analyzeBtn");

const homeScreen = document.getElementById("homeScreen");
const loadingScreen = document.getElementById("loadingScreen");
const reportScreen = document.getElementById("reportScreen");
const reportSection = document.getElementById("reportSection");
const backBtn = document.getElementById("backBtn");
const loadingCopy = document.getElementById("loadingCopy");

const errorText = document.getElementById("errorText");

const profileAvatar = document.getElementById("profileAvatar");
const profileName = document.getElementById("profileName");
const profileUsername = document.getElementById("profileUsername");
const profileLink = document.getElementById("profileLink");
const profileBio = document.getElementById("profileBio");
const roleSummary = document.getElementById("roleSummary");
const kpiRepos = document.getElementById("kpiRepos");
const kpiFollowers = document.getElementById("kpiFollowers");
const kpiFollowing = document.getElementById("kpiFollowing");

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
const seniorityText = document.getElementById("seniorityText");
const reasoningText = document.getElementById("reasoningText");
const roleFitList = document.getElementById("roleFitList");


let loadingTicker = null;
let loadingMessageIndex = 0;
let scoreChart = null;
const SCREEN_TRANSITION_MS = 260;
let screenTransitionId = 0;
let expandLayoutRaf = null;
let expandLayoutTimeout = null;

const loadingMessages = [
  "Fetching GitHub profile data...",
  "Selecting representative repositories...",
  "Cloning repositories for deterministic checks...",
  "Scoring organization, maturity, and consistency...",
  "Synthesizing report with evidence-backed reasoning...",
];

const scoreLabels = {
  overall: "Overall",
  codeOrganization: "Code Organization",
  projectMaturity: "Project Maturity",
  consistencyActivity: "Consistency & Activity",
  codeQuality: "Code Quality",
  projectCompleteness: "Project Completeness",
  professionalSignal: "Professional Signal",
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

function toggleOtherRoleInput() {
  const isOtherRole = roleInput.value === "other";
  otherRoleWrap.classList.toggle("hidden", !isOtherRole);
  otherRoleInput.required = isOtherRole;
  if (!isOtherRole) {
    otherRoleInput.value = "";
  }
}

function createContextLinkInput(value = "") {
  const input = document.createElement("input");
  input.className = "context-link-url";
  input.name = "contextLinkUrl[]";
  input.type = "url";
  input.placeholder = "https://example.com/profile";
  input.value = value;
  return input;
}

function addContextLinkField(value = "") {
  if (!contextLinksList) return;

  const currentCount = contextLinksList.querySelectorAll(".context-link-url").length;
  if (currentCount >= 8) {
    showError("You can add up to 8 context links.");
    return;
  }

  showError("");
  contextLinksList.appendChild(createContextLinkInput(value));
}

function resetContextLinks() {
  if (!contextLinksList) return;
  contextLinksList.innerHTML = "";

  const first = createContextLinkInput();
  first.id = "contextLinkUrl1";
  first.placeholder = "https://example.com/profile";
  contextLinksList.appendChild(first);
}

function collectContextLinks() {
  if (!contextLinksList) return [];

  const links = [];
  const inputs = Array.from(contextLinksList.querySelectorAll(".context-link-url"));

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
  if (panel.classList.contains("recommendation-panel")) return 360;
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

function formatNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return Math.round(parsed).toLocaleString();
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
        labels: ["Overall", "Code Organization", "Project Maturity", "Consistency & Activity"],
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

  renderList(externalContextList, messages, "No external context links were analyzed.");
}

function weightSummary(rolePayload) {
  const weights = rolePayload?.weights;
  if (!weights) return "Deterministic score model was applied.";

  const code = Math.round((weights.codeOrganization || 0) * 100);
  const maturity = Math.round((weights.projectMaturity || 0) * 100);
  const consistency = Math.round((weights.consistencyActivity || 0) * 100);

  return `Weighting (${rolePayload.label || "Role"}): Code Organization ${code}% | Project Maturity ${maturity}% | Consistency ${consistency}%`;
}

function renderProfile(profile, rolePayload) {
  profileAvatar.src = profile.avatarUrl || "";
  profileAvatar.alt = `${profile.username || "GitHub"} avatar`;
  profileName.textContent = profile.name || "Name not provided";
  profileUsername.textContent = `@${profile.username || "-"}`;
  profileLink.href = profile.htmlUrl || "#";
  profileBio.textContent = profile.bio || "No public bio.";
  roleSummary.textContent = rolePayload
    ? `Role Focus: ${rolePayload.label || rolePayload.selectedRole || "Recruiter"}`
    : "Role Focus: Recruiter";

  kpiRepos.textContent = formatNumber(profile.publicRepos);
  kpiFollowers.textContent = formatNumber(profile.followers);
  kpiFollowing.textContent = formatNumber(profile.following);
}

function resetReportView() {
  clearExpandablePanels();

  profileAvatar.src = "";
  profileAvatar.alt = "GitHub avatar";
  profileName.textContent = "-";
  profileUsername.textContent = "-";
  profileLink.href = "#";
  profileBio.textContent = "";
  roleSummary.textContent = "";

  kpiRepos.textContent = "0";
  kpiFollowers.textContent = "0";
  kpiFollowing.textContent = "0";

  scoreMethodText.textContent = "";
  if (chartStatusText) {
    chartStatusText.classList.add("hidden");
    chartStatusText.textContent = "";
  }
  summaryText.innerHTML = "<p>-</p>";
  roleImpactText.innerHTML = "<p>-</p>";
  scoreboard.innerHTML = "";

  decisionText.textContent = "-";
  seniorityText.textContent = "";
  reasoningText.innerHTML = "";

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

toggleOtherRoleInput();
roleInput.addEventListener("change", toggleOtherRoleInput);

if (addContextLinkBtn) {
  addContextLinkBtn.addEventListener("click", () => addContextLinkField());
}

window.addEventListener("resize", () => {
  if (reportScreen.classList.contains("hidden")) return;
  refreshExpandablePanels();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  showError("");
  setSubmitState(true);
  setScreen("loading");
  startLoadingTicker();

  try {
    const username = githubInput.value.trim();
    const context = contextInput.value.trim();
    const role = roleInput.value;
    const roleOther = otherRoleInput.value.trim();

    if (role === "other" && !roleOther) {
      throw new Error("Please specify the Other target role.");
    }

    const contextLinks = collectContextLinks();

    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, context, role, roleOther, contextLinks }),
    });

    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || "Request failed.");
    }

    const report = payload.report || {};
    const recommendation = report.recommendation || {};
    const evidenceRepos = payload.evidence?.repos || [];
    const rolePayload = payload.role || null;

    renderProfile(payload.profile || {}, rolePayload);

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
    seniorityText.textContent = recommendation.senioritySignal
      ? "Seniority Signal: " + recommendation.senioritySignal
      : "";
    setMarkdownContent(reasoningText, recommendation.reasoning, "No recommendation reasoning returned.");

    setScreen("report");
    requestAnimationFrame(() => {
      renderScoreChart(report.scores || {});
      refreshExpandablePanels();
    });
  } catch (error) {
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
  toggleOtherRoleInput();
  resetContextLinks();
  resetReportView();
  showError("");
  setScreen("home");
  githubInput.focus();
});
