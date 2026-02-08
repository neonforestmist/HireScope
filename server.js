const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GITHUB_TOKEN_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_API_KEY",
  "GITHUB_ACCESS_TOKEN",
];
let githubTokenSource = "none";
const GITHUB_TOKEN = resolveGitHubToken();

const PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const MIN_SELECTED_REPOS = 3;
const MAX_SELECTED_REPOS = 5;
const MAX_CANDIDATE_REPOS = 12;
const MAX_REPO_SCAN_ENTRIES = 8000;
const MAX_TREE_PREVIEW = 40;
const CLONE_TIMEOUT_MS = 120000;
const EXTERNAL_CONTEXT_CACHE_TTL_MS = 60 * 60 * 1000;
const EXTERNAL_CONTEXT_FETCH_TIMEOUT_MS = 7000;
const EXTERNAL_CONTEXT_MAX_SNIPPET_CHARS = 320;

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".go",
  ".rb",
  ".rs",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sql",
  ".sh",
  ".html",
  ".css",
]);

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "target",
  "out",
  "venv",
  ".venv",
]);

const ROLE_CONFIG = {
  recruiter: {
    label: "Recruiter",
    weights: {
      codeOrganization: 0.45,
      projectMaturity: 0.35,
      consistencyActivity: 0.2,
    },
    impactNote:
      "Applies a senior-engineer hiring lens: architecture quality, maintainability, delivery maturity, and consistent ownership signals.",
  },
  developer: {
    label: "Developer",
    weights: {
      codeOrganization: 0.45,
      projectMaturity: 0.3,
      consistencyActivity: 0.25,
    },
    impactNote:
      "Prioritizes architecture clarity and implementation quality while preserving maturity and consistency checks.",
  },
  other: {
    label: "Other",
    weights: {
      codeOrganization: 0.34,
      projectMaturity: 0.33,
      consistencyActivity: 0.33,
    },
    impactNote:
      "Uses balanced weighting and applies custom role context to hiring recommendation language.",
  },
};

const DEMO_PROFILES = ["torvalds", "gaearon", "tj", "sindresorhus"];

const profileCache = new Map();
const resultCache = new Map();
const githubCache = new Map();
const externalContextCache = new Map();
const rateLimitStore = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function getCached(map, key, ttlMs) {
  const cached = map.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > ttlMs) {
    map.delete(key);
    return null;
  }

  return cached.data;
}

function setCached(map, key, data) {
  map.set(key, { data, timestamp: Date.now() });
}

function pruneExpiredCache(map, ttlMs) {
  const now = Date.now();
  for (const [key, entry] of map.entries()) {
    if (now - entry.timestamp > ttlMs) {
      map.delete(key);
    }
  }
}

setInterval(() => {
  pruneExpiredCache(profileCache, PROFILE_CACHE_TTL_MS);
  pruneExpiredCache(resultCache, RESULT_CACHE_TTL_MS);
  pruneExpiredCache(githubCache, GITHUB_CACHE_TTL_MS);
  pruneExpiredCache(externalContextCache, EXTERNAL_CONTEXT_CACHE_TTL_MS);
}, 5 * 60 * 1000).unref();

function parseGithubUsername(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})(?:$|[/?#])/i
  );
  if (urlMatch && urlMatch[1]) return urlMatch[1];

  const usernameMatch = trimmed.match(/^[A-Za-z0-9-]{1,39}$/);
  if (usernameMatch) return trimmed;

  return null;
}

function normalizeRole(value) {
  if (typeof value !== "string") return "recruiter";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "recruiter";
  return Object.prototype.hasOwnProperty.call(ROLE_CONFIG, normalized)
    ? normalized
    : "recruiter";
}

function normalizeOtherRole(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeContextLinks(value) {
  if (!Array.isArray(value)) return [];

  const normalized = [];
  for (const item of value.slice(0, 8)) {
    let rawLabel = "";
    let rawUrl = "";

    if (typeof item === "string") {
      rawUrl = item.trim();
    } else if (item && typeof item === "object") {
      rawLabel = typeof item.label === "string" ? item.label.trim() : "";
      rawUrl = typeof item.url === "string" ? item.url.trim() : "";
    }

    if (!rawUrl) continue;

    try {
      const parsedUrl = new URL(rawUrl);
      const protocol = parsedUrl.protocol.toLowerCase();
      if (!["http:", "https:"].includes(protocol)) continue;

      const hostRaw = parsedUrl.hostname.toLowerCase();
      const isBlockedHost =
        hostRaw === "localhost" ||
        hostRaw === "0.0.0.0" ||
        hostRaw === "::1" ||
        hostRaw === "[::1]" ||
        hostRaw === "169.254.169.254" ||
        /^127\./.test(hostRaw) ||
        /^10\./.test(hostRaw) ||
        /^192\.168\./.test(hostRaw) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostRaw);
      if (isBlockedHost) continue;

      const hostname = parsedUrl.hostname.replace(/^www\./, "");
      const hostSeed = hostname.split(".")[0] || "External Context";

      normalized.push({
        label: (rawLabel || hostSeed || "External Context").slice(0, 60),
        url: parsedUrl.toString(),
      });
    } catch (_error) {
      // Skip invalid URLs.
    }
  }

  return normalized;
}
function buildRoleConfig(role, otherRole) {
  const base = ROLE_CONFIG[role] || ROLE_CONFIG.recruiter;
  if (role !== "other" || !otherRole) return base;

  return {
    ...base,
    label: "Other (" + otherRole + ")",
    impactNote:
      "Balanced scoring model adapted for " +
      otherRole +
      ", with emphasis interpreted through the custom role context.",
  };
}

function resolveGitHubToken() {
  for (const key of GITHUB_TOKEN_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      githubTokenSource = key;
      return value.trim();
    }
  }

  try {
    const ghToken = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();

    if (ghToken) {
      githubTokenSource = "gh-auth-token";
      return ghToken;
    }
  } catch (_error) {
    // gh CLI is unavailable or not authenticated.
  }

  githubTokenSource = "none";
  return "";
}

function parseGitHubErrorMessage(rawBody) {
  if (typeof rawBody !== "string" || !rawBody.trim()) return "";

  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed.message === "string") {
      return parsed.message.trim();
    }
  } catch (_error) {
    // Keep raw message fallback.
  }

  return rawBody.trim().slice(0, 320);
}

function buildGitHubHttpError(res, rawBody = "") {
  const apiMessage = parseGitHubErrorMessage(rawBody);
  const isRateLimited =
    res.status === 403 && /rate limit exceeded|secondary rate limit/i.test(apiMessage);

  if (isRateLimited) {
    const resetEpoch = Number.parseInt(res.headers.get("x-ratelimit-reset") || "", 10);
    const resetIso =
      Number.isFinite(resetEpoch) && resetEpoch > 0
        ? new Date(resetEpoch * 1000).toISOString().replace(".000Z", "Z")
        : "";
    const resetHint = resetIso ? ` (resets around ${resetIso})` : "";
    const authHint = GITHUB_TOKEN
      ? " GitHub token quota is exhausted."
      : " Add GITHUB_TOKEN (or GH_TOKEN/GITHUB_PAT) to raise the limit.";

    const error = new Error(`GitHub API rate limit exceeded${resetHint}.${authHint}`);
    error.status = 429;
    error.code = "GITHUB_RATE_LIMIT";
    return error;
  }

  const message = apiMessage
    ? `GitHub request failed (${res.status}): ${apiMessage}`
    : `GitHub request failed (${res.status})`;
  const error = new Error(message);
  error.status = res.status;
  return error;
}

function githubHeaders(accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "HireScope-App",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return headers;
}

async function fetchGitHub(url, options = {}) {
  const {
    accept = "application/vnd.github+json",
    responseType = "json",
    allow404 = false,
    cacheTtlMs = GITHUB_CACHE_TTL_MS,
  } = options;

  const cacheKey = `${accept}|${responseType}|${url}`;
  if (cacheTtlMs > 0) {
    const cached = getCached(githubCache, cacheKey, cacheTtlMs);
    if (cached !== null) return cached;
  }

  const res = await fetch(url, { headers: githubHeaders(accept) });

  if (allow404 && res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const rawBody = await res.text().catch(() => "");
    throw buildGitHubHttpError(res, rawBody);
  }

  const data = responseType === "text" ? await res.text() : await res.json();

  if (cacheTtlMs > 0) {
    setCached(githubCache, cacheKey, data);
  }

  return data;
}

async function fetchReadme(owner, repo) {
  const readmeUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const text = await fetchGitHub(readmeUrl, {
    accept: "application/vnd.github.raw+json",
    responseType: "text",
    allow404: true,
  });

  if (!text) return null;
  return text.slice(0, 12000);
}

function parseLastPageFromLinkHeader(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/[?&]page=(\d+)>; rel="last"/);
  if (!match || !match[1]) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function estimateCommitCount(owner, repo, branch, sinceIso) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set("per_page", "1");
  if (branch) url.searchParams.set("sha", branch);
  if (sinceIso) url.searchParams.set("since", sinceIso);

  const res = await fetch(url, { headers: githubHeaders() });

  if (res.status === 404 || res.status === 409) return 0;

  if (!res.ok) {
    const rawBody = await res.text().catch(() => "");
    const error = buildGitHubHttpError(res, rawBody);
    if (error.code !== "GITHUB_RATE_LIMIT") {
      error.message = `${error.message} for ${owner}/${repo}`;
    }
    throw error;
  }

  const lastPage = parseLastPageFromLinkHeader(res.headers.get("link"));
  if (lastPage) return lastPage;

  const payload = await res.json();
  return Array.isArray(payload) ? payload.length : 0;
}

async function fetchCommitMetrics(owner, repo, defaultBranch) {
  const cacheKey = `commit-metrics|${owner}|${repo}|${defaultBranch || ""}`;
  const cached = getCached(githubCache, cacheKey, GITHUB_CACHE_TTL_MS);
  if (cached !== null) return cached;

  const since90Days = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const [totalResult, recentResult] = await Promise.allSettled([
    estimateCommitCount(owner, repo, defaultBranch),
    estimateCommitCount(owner, repo, defaultBranch, since90Days),
  ]);

  const totalCommits =
    totalResult.status === "fulfilled" && Number.isFinite(totalResult.value)
      ? totalResult.value
      : 0;

  const recentCommits90d =
    recentResult.status === "fulfilled" && Number.isFinite(recentResult.value)
      ? recentResult.value
      : 0;

  const metrics = {
    totalCommits,
    recentCommits90d,
    commitsPerMonth90d: Math.round((recentCommits90d / 3) * 10) / 10,
  };

  setCached(githubCache, cacheKey, metrics);
  return metrics;
}

function daysSince(dateIso) {
  if (!dateIso) return 3650;
  const value = new Date(dateIso).getTime();
  if (Number.isNaN(value)) return 3650;
  const diff = Date.now() - value;
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function languageFrequency(repos) {
  const frequency = {};

  for (const repo of repos) {
    const language = (repo.language || "unknown").toLowerCase();
    if (language === "unknown") continue;
    frequency[language] = (frequency[language] || 0) + 1;
  }

  return frequency;
}

function calculateSelectionBaseScore(repo, frequencyMap) {
  const recencyDays = daysSince(repo.pushed_at);

  let recencyScore = 2;
  if (recencyDays <= 14) recencyScore = 35;
  else if (recencyDays <= 45) recencyScore = 28;
  else if (recencyDays <= 120) recencyScore = 20;
  else if (recencyDays <= 240) recencyScore = 10;

  const stars = Number(repo.stargazers_count || 0);
  const starsScore = Math.min(25, Math.round(Math.log10(stars + 1) * 12));

  const language = (repo.language || "unknown").toLowerCase();
  const maxFrequency = Math.max(1, ...Object.values(frequencyMap), 1);
  const languageScore =
    language !== "unknown" ? Math.round(((frequencyMap[language] || 0) / maxFrequency) * 15) : 3;

  const sizeKb = Number(repo.size || 0);
  let sizeScore = 5;
  if (sizeKb >= 120) sizeScore = 10;
  if (sizeKb >= 800) sizeScore = 14;

  const baseScore = recencyScore + starsScore + languageScore + sizeScore;

  return {
    baseScore,
    factors: {
      recencyDays,
      stars,
      language: repo.language || "Unknown",
      sizeKb,
      recencyScore,
      starsScore,
      languageScore,
      sizeScore,
    },
  };
}

function buildSelectionJustification(repo, factors, commitMetrics) {
  return `${repo.name} was selected for strong representativeness: ${factors.recencyDays} days since last push, ${factors.stars} stars, ${commitMetrics.recentCommits90d} commits in the last 90 days, and ${factors.language} as a recurring language signal.`;
}

async function mapWithConcurrency(items, limit, mapper) {
  const safeLimit = Math.max(1, Math.floor(limit));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}


function compactExternalText(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHtmlMeta(html, attrName, attrValue) {
  if (typeof html !== "string" || !html) return "";

  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]*${attrName}=["']${escaped}["'][^>]*content=["']([^"']{1,600})["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']{1,600})["'][^>]*${attrName}=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return compactExternalText(match[1]);
  }

  return "";
}

function extractExternalContextSummaryFromHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{1,400}?)<\/title>/i);
  const title = titleMatch && titleMatch[1] ? compactExternalText(titleMatch[1]) : "";

  const description =
    extractHtmlMeta(html, "property", "og:description") ||
    extractHtmlMeta(html, "name", "description") ||
    extractHtmlMeta(html, "property", "twitter:description");

  const headingMatch = html.match(/<h1[^>]*>([\s\S]{1,500}?)<\/h1>/i);
  const heading = headingMatch && headingMatch[1] ? compactExternalText(headingMatch[1]) : "";

  const bodyText = compactExternalText(html).slice(0, EXTERNAL_CONTEXT_MAX_SNIPPET_CHARS);

  return {
    title,
    description,
    heading,
    snippet: bodyText,
  };
}

function isLinkedInUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;

  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
    return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  } catch (_error) {
    return /linkedin\.com/i.test(rawUrl);
  }
}

async function fetchExternalContextLink(link) {
  const cacheKey = `external-context|${link.url}`;
  const cached = getCached(externalContextCache, cacheKey, EXTERNAL_CONTEXT_CACHE_TTL_MS);
  if (cached) return cached;

  if (isLinkedInUrl(link.url)) {
    const summary = {
      label: link.label,
      url: link.url,
      finalUrl: link.url,
      status: 0,
      reachable: true,
      restricted: true,
      title: "",
      description: "",
      heading: "",
      snippet: "",
      note:
        "LinkedIn pages are usually auth-gated and block automated fetches; recommendation uses GitHub evidence with limited external context.",
    };

    setCached(externalContextCache, cacheKey, summary);
    return summary;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_CONTEXT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(link.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "HireScope-App",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
    });

    const raw = await response.text();
    const extracted = extractExternalContextSummaryFromHtml(raw);

    const finalUrl = response.url || link.url;
    const sourceUrl = finalUrl || link.url;
    const isLinkedIn = isLinkedInUrl(sourceUrl);

    const detectionText = `${extracted.title} ${extracted.description} ${extracted.heading} ${extracted.snippet}`;
    const restricted =
      isLinkedIn &&
      /(sign in|join linkedin|logged out|authentication required|challenge)/i.test(detectionText);

    const summary = {
      label: link.label,
      url: link.url,
      finalUrl,
      status: response.status,
      reachable: response.ok,
      restricted,
      title: extracted.title,
      description: extracted.description,
      heading: extracted.heading,
      snippet: extracted.snippet,
      note: response.ok
        ? restricted
          ? "Page responded but public content is limited (likely auth-gated)."
          : "Public metadata and text snippet extracted."
        : `Could not access page content (status ${response.status}).`,
    };

    setCached(externalContextCache, cacheKey, summary);
    return summary;
  } catch (error) {
    const timeoutHit = error && error.name === "AbortError";
    const summary = {
      label: link.label,
      url: link.url,
      finalUrl: link.url,
      status: 0,
      reachable: false,
      restricted: false,
      title: "",
      description: "",
      heading: "",
      snippet: "",
      note: timeoutHit
        ? "Timed out while fetching this link."
        : "Unable to fetch this link from the server.",
    };

    setCached(externalContextCache, cacheKey, summary);
    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveExternalContext(contextLinks) {
  if (!Array.isArray(contextLinks) || contextLinks.length === 0) return [];
  return mapWithConcurrency(contextLinks, 2, (entry) => fetchExternalContextLink(entry));
}

function buildExternalContextSignals(externalContext) {
  if (!Array.isArray(externalContext) || externalContext.length === 0) return [];

  return externalContext.map((entry) => {
    if (!entry.reachable) {
      return `${entry.label}: ${entry.note}`;
    }

    if (entry.restricted) {
      const detail = entry.title || entry.description || "Limited public details available.";
      return `${entry.label}: restricted public view. ${detail}`;
    }

    const parts = [];
    if (entry.title) parts.push(`title: ${entry.title}`);
    if (entry.description) parts.push(`description: ${entry.description}`);
    if (parts.length === 0 && entry.snippet) parts.push(`snippet: ${entry.snippet}`);

    return `${entry.label}: ${parts.join(" | ") || "Public link reachable but no clear summary text."}`;
  });
}

function buildExternalContextRecommendationSummary(externalContext) {
  if (!Array.isArray(externalContext) || externalContext.length === 0) {
    return {
      note: "No external profile links were provided for additional hiring context.",
      highlights: [],
      totals: { total: 0, reachable: 0, usable: 0 },
    };
  }

  const reachable = externalContext.filter((entry) => entry && entry.reachable);
  const usable = reachable.filter((entry) => !entry.restricted);

  const highlights = usable
    .map((entry) => {
      const segments = [entry.title, entry.description, entry.heading]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean);

      const deduped = Array.from(new Set(segments)).slice(0, 2).join(" | ");
      if (!deduped) return "";

      return `${entry.label}: ${deduped}`.slice(0, 240);
    })
    .filter(Boolean)
    .slice(0, 3);

  let note = "";
  if (highlights.length > 0) {
    note = "External context considered: " + highlights.join(" || ");
  } else if (reachable.length > 0) {
    note =
      "External links were reachable but mostly restricted/auth-gated, so recommendation stays mostly weighted toward GitHub evidence.";
  } else {
    note = "External links could not be fetched from the server, so recommendation is based on GitHub evidence only.";
  }

  return {
    note,
    highlights,
    totals: {
      total: externalContext.length,
      reachable: reachable.length,
      usable: usable.length,
    },
  };
}

function recommendationLineKey(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return "";

  if (/external links?.*(could not be fetched|unable to fetch|timed out|could not access)/i.test(text)) {
    return "external-unreachable";
  }
  if (/(external links?|external context).*(restricted|auth-gated|limited public)/i.test(text)) {
    return "external-limited";
  }
  if (/(external context considered|considered public signals from)/i.test(text)) {
    return "external-considered";
  }
  if (/user provided \d+ external link/i.test(text)) {
    return "external-provided";
  }

  return text.replace(/[^a-z0-9]+/g, " ").trim();
}

function dedupeRecommendationLines(items) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();
  const deduped = [];

  for (const raw of items) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value) continue;

    const key = recommendationLineKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

function mergeRecommendationReasoning(baseReasoning, externalContextNote) {
  const base = typeof baseReasoning === "string" ? baseReasoning.trim() : "";
  const note = typeof externalContextNote === "string" ? externalContextNote.trim() : "";
  if (!note) return base;

  const externalSentence = /^external context:/i.test(note)
    ? note
    : `External context: ${note}`;
  if (!base) return externalSentence;
  if (/external context:/i.test(base)) return base;

  const baseKey = recommendationLineKey(base);
  const noteKey = recommendationLineKey(note);
  if (baseKey && noteKey && baseKey.includes(noteKey)) {
    return base;
  }

  return `${base} ${externalSentence}`.replace(/\s+/g, " ").trim();
}

async function pickReposForDeepAnalysis(repos) {
  const eligible = repos.filter(
    (repo) => !repo.fork && !repo.archived && Number(repo.size || 0) > 0
  );

  if (eligible.length === 0) {
    return {
      selected: [],
      meta: {
        totalRepos: repos.length,
        eligibleRepos: 0,
      },
    };
  }

  const frequencyMap = languageFrequency(eligible);

  const preliminary = eligible
    .map((repo) => {
      const { baseScore, factors } = calculateSelectionBaseScore(repo, frequencyMap);
      return { repo, baseScore, factors };
    })
    .sort((a, b) => b.baseScore - a.baseScore)
    .slice(0, Math.min(MAX_CANDIDATE_REPOS, eligible.length));

  const enrichedCandidates = await mapWithConcurrency(preliminary, 4, async (candidate) => {
    const owner = candidate.repo?.owner?.login;
    const commitMetrics = await fetchCommitMetrics(
      owner,
      candidate.repo.name,
      candidate.repo.default_branch
    ).catch(() => ({ totalCommits: 0, recentCommits90d: 0, commitsPerMonth90d: 0 }));

    const activityBonus = Math.min(25, Math.round(commitMetrics.recentCommits90d * 1.6));
    const selectionScore = candidate.baseScore + activityBonus;

    return {
      ...candidate,
      commitMetrics,
      selectionScore,
      justification: buildSelectionJustification(candidate.repo, candidate.factors, commitMetrics),
    };
  });

  const sorted = enrichedCandidates.sort((a, b) => b.selectionScore - a.selectionScore);
  const selectionCount =
    sorted.length >= MIN_SELECTED_REPOS
      ? Math.min(MAX_SELECTED_REPOS, sorted.length)
      : sorted.length;

  return {
    selected: sorted.slice(0, selectionCount),
    meta: {
      totalRepos: repos.length,
      eligibleRepos: eligible.length,
      consideredRepos: preliminary.length,
    },
  };
}

function isLikelyTestPath(relativePath, lowerName) {
  const pathLower = relativePath.toLowerCase();

  if (/(^|\/)(__tests__|tests?|spec)(\/|$)/.test(pathLower)) {
    return true;
  }

  if (/\.(test|spec)\./.test(lowerName)) {
    return true;
  }

  return /_test\.[a-z0-9]+$/.test(lowerName);
}

function createEmptyRepoStructure() {
  return {
    topLevel: [],
    treePreview: [],
    totalFiles: 0,
    totalDirs: 0,
    sourceFileCount: 0,
    locEstimate: 0,
    readme: {
      present: false,
      length: 0,
    },
    tests: {
      testDirectoryCount: 0,
      testFileCount: 0,
      hasTests: false,
    },
    licensePresent: false,
  };
}

async function inspectClonedRepository(repoPath) {
  const metrics = createEmptyRepoStructure();
  const stack = [{ absolute: repoPath, relative: "", depth: 0 }];
  let scannedEntries = 0;

  while (stack.length > 0 && scannedEntries < MAX_REPO_SCAN_ENTRIES) {
    const current = stack.pop();

    let entries = [];
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      if (scannedEntries >= MAX_REPO_SCAN_ENTRIES) break;

      scannedEntries += 1;
      const relativePath = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(current.absolute, entry.name);
      const lowerName = entry.name.toLowerCase();

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(lowerName)) continue;

        metrics.totalDirs += 1;

        if (current.depth === 0) {
          metrics.topLevel.push(`${entry.name}/`);
        }

        if (/^(__tests__|tests?|spec)$/.test(lowerName) || lowerName.includes("test")) {
          metrics.tests.testDirectoryCount += 1;
        }

        if (current.depth <= 2 && metrics.treePreview.length < MAX_TREE_PREVIEW) {
          metrics.treePreview.push(`${"  ".repeat(current.depth)}${entry.name}/`);
        }

        if (current.depth < 6) {
          stack.push({
            absolute: absolutePath,
            relative: relativePath,
            depth: current.depth + 1,
          });
        }

        continue;
      }

      if (!entry.isFile()) continue;

      metrics.totalFiles += 1;

      if (current.depth === 0) {
        metrics.topLevel.push(entry.name);
      }

      if (current.depth <= 2 && metrics.treePreview.length < MAX_TREE_PREVIEW) {
        metrics.treePreview.push(`${"  ".repeat(current.depth)}${entry.name}`);
      }

      if (!metrics.readme.present && /^readme(\.|$)/.test(lowerName)) {
        metrics.readme.present = true;
        const readmeText = await fs.readFile(absolutePath, "utf8").catch(() => "");
        metrics.readme.length = readmeText.length;
      }

      if (!metrics.licensePresent && /^licen[sc]e(\.|$)/.test(lowerName)) {
        metrics.licensePresent = true;
      }

      if (isLikelyTestPath(relativePath, lowerName)) {
        metrics.tests.testFileCount += 1;
      }

      const extension = path.extname(lowerName);
      if (!SOURCE_EXTENSIONS.has(extension)) continue;

      metrics.sourceFileCount += 1;
      const content = await fs.readFile(absolutePath, "utf8").catch(() => null);
      if (typeof content === "string") {
        metrics.locEstimate += content.split(/\r?\n/).length;
      }
    }
  }

  metrics.tests.hasTests =
    metrics.tests.testDirectoryCount > 0 || metrics.tests.testFileCount > 0;

  return metrics;
}

async function cloneRepository(repoCloneUrl, clonePath) {
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--quiet", repoCloneUrl, clonePath],
    {
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
}

/**
 * Scoring rubric v1 (deterministic):
 * - codeOrganization: README, test presence, source layout, and file structure hygiene.
 * - projectMaturity: docs depth, license, LOC signals, and total commit depth.
 * - consistencyActivity: recency, recent commit cadence, and sustained commit history.
 */
function calculateRepoScores(signals) {
  const codeOrganization = clampScore(
    (signals.readme.present ? 22 : 6) +
      (signals.tests.hasTests ? 26 : 2) +
      (signals.sourceFileCount >= 8 ? 20 : signals.sourceFileCount >= 3 ? 12 : 4) +
      (signals.topLevel.length >= 3 && signals.topLevel.length <= 18 ? 18 : 10) +
      (signals.locEstimate >= 180 ? 14 : 7)
  );

  const projectMaturity = clampScore(
    (signals.readme.length >= 700 ? 20 : signals.readme.length >= 180 ? 14 : 6) +
      (signals.licensePresent ? 18 : 5) +
      (signals.locEstimate >= 500 ? 18 : signals.locEstimate >= 180 ? 12 : 6) +
      (signals.commitMetrics.totalCommits >= 120
        ? 24
        : signals.commitMetrics.totalCommits >= 40
          ? 16
          : signals.commitMetrics.totalCommits >= 10
            ? 10
            : 4) +
      (signals.hasIssues ? 8 : 4) +
      (signals.hasWiki ? 6 : 2)
  );

  const consistencyActivity = clampScore(
    (signals.recencyDays <= 14
      ? 36
      : signals.recencyDays <= 45
        ? 28
        : signals.recencyDays <= 120
          ? 20
          : signals.recencyDays <= 240
            ? 11
            : 3) +
      (signals.commitMetrics.recentCommits90d >= 35
        ? 34
        : signals.commitMetrics.recentCommits90d >= 15
          ? 24
          : signals.commitMetrics.recentCommits90d >= 5
            ? 14
            : signals.commitMetrics.recentCommits90d >= 1
              ? 8
              : 2) +
      (signals.commitMetrics.totalCommits >= 80
        ? 22
        : signals.commitMetrics.totalCommits >= 25
          ? 14
          : signals.commitMetrics.totalCommits >= 8
            ? 9
            : 4) +
      (signals.archived ? -10 : 0)
  );

  const overall = clampScore((codeOrganization + projectMaturity + consistencyActivity) / 3);

  return {
    overall,
    codeOrganization,
    projectMaturity,
    consistencyActivity,
  };
}

function aggregateProfileScores(repoEvidence, roleConfig) {
  if (!Array.isArray(repoEvidence) || repoEvidence.length === 0) {
    return {
      overall: 0,
      codeOrganization: 0,
      projectMaturity: 0,
      consistencyActivity: 0,
      codeQuality: 0,
      projectCompleteness: 0,
      professionalSignal: 0,
    };
  }

  let totalWeight = 0;
  let codeOrganization = 0;
  let projectMaturity = 0;
  let consistencyActivity = 0;

  for (const repo of repoEvidence) {
    const repoWeight = Math.max(1, Number(repo.selection.selectionScore || 1));
    totalWeight += repoWeight;

    codeOrganization += repo.scores.codeOrganization * repoWeight;
    projectMaturity += repo.scores.projectMaturity * repoWeight;
    consistencyActivity += repo.scores.consistencyActivity * repoWeight;
  }

  const normalizedCodeOrganization = codeOrganization / totalWeight;
  const normalizedProjectMaturity = projectMaturity / totalWeight;
  const normalizedConsistencyActivity = consistencyActivity / totalWeight;

  const overall = clampScore(
    normalizedCodeOrganization * roleConfig.weights.codeOrganization +
      normalizedProjectMaturity * roleConfig.weights.projectMaturity +
      normalizedConsistencyActivity * roleConfig.weights.consistencyActivity
  );

  return {
    overall,
    codeOrganization: clampScore(normalizedCodeOrganization),
    projectMaturity: clampScore(normalizedProjectMaturity),
    consistencyActivity: clampScore(normalizedConsistencyActivity),
    // Backward-compatible keys used by the existing UI.
    codeQuality: clampScore(normalizedCodeOrganization),
    projectCompleteness: clampScore(normalizedProjectMaturity),
    professionalSignal: clampScore(normalizedConsistencyActivity),
  };
}

function formatLanguageLabel(language) {
  const normalized = typeof language === "string" ? language.trim().toLowerCase() : "";
  if (!normalized) return "Unknown";

  const known = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    "c#": "C#",
    "c++": "C++",
    "objective-c": "Objective-C",
    "objective-c++": "Objective-C++",
    "jupyter notebook": "Jupyter Notebook",
    html: "HTML",
    css: "CSS",
    sql: "SQL",
  };

  if (known[normalized]) return known[normalized];

  return normalized
    .split(/[\s_-]+/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

function inferRoleFitLinesFromRepoEvidence(repoEvidence) {
  if (!Array.isArray(repoEvidence) || repoEvidence.length === 0) return [];

  const languageWeights = {};
  const keywordWeights = {
    frontend: 0,
    backend: 0,
    mobile: 0,
    data: 0,
    devops: 0,
  };

  const keywordPatterns = {
    frontend:
      /(front[-\s]?end|react|next\.?js|vue|angular|svelte|ui|ux|client|webapp|web-app|component)/i,
    backend:
      /(back[-\s]?end|api|server|service|microservice|graphql|database|db|express|fastapi|django|flask|spring|nestjs|auth)/i,
    mobile: /(mobile|android|ios|react[-\s]?native|flutter|swiftui|xcode)/i,
    data:
      /(data|etl|pipeline|analytics|notebook|ml|machine learning|model|pytorch|tensorflow|scikit|spark)/i,
    devops:
      /(devops|infra|terraform|kubernetes|k8s|helm|ansible|docker|ci\/cd|ci-cd|workflow|deployment|sre|platform)/i,
  };

  let totalWeight = 0;
  let reposWithTests = 0;

  for (const entry of repoEvidence) {
    const weight = Math.max(1, Number(entry?.selection?.selectionScore || 1));
    totalWeight += weight;

    const language =
      typeof entry?.repo?.language === "string" ? entry.repo.language.trim().toLowerCase() : "";
    if (language && language !== "unknown") {
      languageWeights[language] = (languageWeights[language] || 0) + weight;
    }

    if (entry?.signals?.tests?.hasTests) {
      reposWithTests += 1;
    }

    const topLevel = Array.isArray(entry?.signals?.topLevel) ? entry.signals.topLevel : [];
    const repoText = [entry?.repo?.name, entry?.repo?.description, ...topLevel]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
      .toLowerCase();

    if (!repoText) continue;

    for (const [key, pattern] of Object.entries(keywordPatterns)) {
      if (pattern.test(repoText)) {
        keywordWeights[key] += weight;
      }
    }
  }

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return [];

  const shareForLanguages = (languages) =>
    languages.reduce((sum, language) => sum + (languageWeights[language] || 0), 0) / totalWeight;
  const keywordShare = (key) => keywordWeights[key] / totalWeight;

  const frontendSignal =
    shareForLanguages(["javascript", "typescript", "html", "css", "vue", "svelte"]) * 0.75 +
    keywordShare("frontend") * 0.25;
  const backendSignal =
    shareForLanguages([
      "python",
      "java",
      "go",
      "rust",
      "c#",
      "php",
      "ruby",
      "kotlin",
      "scala",
      "c++",
      "javascript",
      "typescript",
    ]) *
      0.7 +
    keywordShare("backend") * 0.3;
  const mobileSignal =
    shareForLanguages(["swift", "kotlin", "objective-c", "objective-c++", "dart", "java"]) * 0.65 +
    keywordShare("mobile") * 0.35;
  const dataSignal =
    shareForLanguages(["python", "jupyter notebook", "r", "scala", "sql"]) * 0.7 +
    keywordShare("data") * 0.3;
  const devopsSignal =
    shareForLanguages(["shell", "dockerfile", "hcl", "makefile", "powershell"]) * 0.65 +
    keywordShare("devops") * 0.35;
  const fullStackSignal =
    Math.min(frontendSignal, backendSignal) * 0.85 +
    shareForLanguages(["javascript", "typescript"]) * 0.15;

  const roleSignals = [
    { label: "Full-Stack Engineer", signal: fullStackSignal },
    { label: "Backend Engineer", signal: backendSignal },
    { label: "Frontend Engineer", signal: frontendSignal },
    { label: "Mobile Engineer", signal: mobileSignal },
    { label: "Data/ML Engineer", signal: dataSignal },
    { label: "DevOps/Platform Engineer", signal: devopsSignal },
  ]
    .map((item) => ({
      ...item,
      signal: Math.max(0, Math.min(1, item.signal)),
    }))
    .sort((a, b) => b.signal - a.signal);

  let selectedRoles = roleSignals.filter((item) => item.signal >= 0.24).slice(0, 3);
  if (selectedRoles.length === 0 && roleSignals[0] && roleSignals[0].signal > 0) {
    selectedRoles = [roleSignals[0]];
  }

  const topLanguageNotes = Object.entries(languageWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(
      ([language, weight]) => `${formatLanguageLabel(language)} ${Math.round((weight / totalWeight) * 100)}%`
    );

  if (selectedRoles.length === 0) {
    const genericEvidence = [];
    if (topLanguageNotes.length > 0) {
      genericEvidence.push(`dominant languages: ${topLanguageNotes.join(", ")}`);
    }
    genericEvidence.push(`tests detected in ${reposWithTests}/${repoEvidence.length} sampled repos`);

    return [
      "Possible roles from repository signals: General Software Engineer (specialization signal is limited).",
      `Role-path evidence: ${genericEvidence.join("; ")}.`,
    ];
  }

  const signalTier = (signal) => {
    if (signal >= 0.6) return "strong";
    if (signal >= 0.38) return "moderate";
    return "emerging";
  };

  const roleSummary = selectedRoles
    .map((role) => `${role.label} (${signalTier(role.signal)} signal)`)
    .join(", ");

  const evidenceParts = [];
  if (topLanguageNotes.length > 0) {
    evidenceParts.push(`dominant languages: ${topLanguageNotes.join(", ")}`);
  }
  evidenceParts.push(`tests detected in ${reposWithTests}/${repoEvidence.length} sampled repos`);

  return [
    `Possible roles from repository signals: ${roleSummary}.`,
    `Role-path evidence: ${evidenceParts.join("; ")}.`,
  ];
}

function compactSingleLineText(value, maxChars = 220) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).replace(/[\s,;:.-]+$/g, "")}...`;
}

function sentenceCount(value) {
  const text = compactSingleLineText(value, 2000);
  if (!text) return 0;

  const matches = text.match(/[^.!?]+[.!?]/g);
  if (matches && matches.length > 0) return matches.length;
  return 1;
}

function normalizeEvaluationModeBlurb(candidate, fallback, context) {
  const normalized = compactSingleLineText(candidate, 1100);
  const fallbackNormalized = compactSingleLineText(fallback, 1100);
  const fallbackValue = fallbackNormalized || "No evaluation-mode introduction returned.";

  if (!normalized) return fallbackValue;
  const count = sentenceCount(normalized);
  if (count < 3 || count > 4) return fallbackValue;

  const hasGithubReference = /(github|repository|repositories|repo)/i.test(normalized);
  if (!hasGithubReference) return fallbackValue;

  const hasUserContext = Boolean(compactSingleLineText(context, 220));
  const hasContextReference = /(context|requested|emphasis|focus|priorit|guidance)/i.test(normalized);
  if (hasUserContext && !hasContextReference) return fallbackValue;
  if (!hasUserContext && !hasContextReference) return fallbackValue;

  return normalized;
}

function buildEvaluationModeBlurb({ roleConfig, context, repoEvidence, profileScores }) {
  const roleLabel =
    roleConfig && typeof roleConfig.label === "string" && roleConfig.label.trim()
      ? roleConfig.label.trim()
      : "Recruiter";
  const impactNote = compactSingleLineText(roleConfig?.impactNote, 280);
  const repos = Array.isArray(repoEvidence) ? repoEvidence : [];
  const repoCount = repos.length;

  const languageWeights = {};
  let totalWeight = 0;
  let reposWithTests = 0;
  let totalRecentCommits90d = 0;

  for (const repo of repos) {
    const weight = Math.max(1, Number(repo?.selection?.selectionScore || 1));
    totalWeight += weight;

    if (repo?.signals?.tests?.hasTests) {
      reposWithTests += 1;
    }

    const recentCommits = Number(repo?.signals?.commitMetrics?.recentCommits90d || 0);
    totalRecentCommits90d += Number.isFinite(recentCommits) ? recentCommits : 0;

    const language =
      typeof repo?.repo?.language === "string" ? repo.repo.language.trim().toLowerCase() : "";
    if (language && language !== "unknown") {
      languageWeights[language] = (languageWeights[language] || 0) + weight;
    }
  }

  const dominantLanguages = Object.entries(languageWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([language, weight]) => {
      const percent = totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0;
      return `${formatLanguageLabel(language)} (${percent}%)`;
    });

  const sampledRepoNames = repos
    .map((repo) => (typeof repo?.repo?.name === "string" ? repo.repo.name.trim() : ""))
    .filter(Boolean)
    .slice(0, 3);

  const cleanContext = compactSingleLineText(context, 190).replace(/"/g, "'");
  const overallScore = Number.isFinite(profileScores?.overall) ? profileScores.overall : 0;

  const sentence1 =
    impactNote && impactNote.endsWith(".")
      ? impactNote
      : impactNote
        ? `${impactNote}.`
        : `${roleLabel} mode applies deterministic weighting across architecture, project maturity, and activity consistency.`;

  const sentence2 =
    repoCount > 0
      ? `GitHub evidence was drawn from ${repoCount} representative repositories${sampledRepoNames.length > 0 ? ` (${sampledRepoNames.join(", ")})` : ""}, showing dominant language signals in ${dominantLanguages.length > 0 ? dominantLanguages.join(", ") : "mixed/undeclared stacks"}, tests in ${reposWithTests}/${repoCount} repos, and ${totalRecentCommits90d} commits over the last 90 days across sampled projects.`
      : "GitHub evidence was limited because no representative repositories were available for deterministic scoring.";

  const sentence3 = cleanContext
    ? `The context box emphasis was "${cleanContext}", and this report explicitly used that guidance when interpreting the repository evidence.`
    : "No extra context was provided in the context box, so interpretation stayed anchored to measurable GitHub repository evidence.";

  const sentence4 = `The overall deterministic readiness score is ${overallScore}/100, so Evaluation Mode: ${roleLabel} frames fit based on role-aligned delivery quality, maturity, and execution consistency.`;

  return [sentence1, sentence2, sentence3, sentence4].join(" ");
}

function buildEvidenceHighlights(repoEvidence) {
  const highlights = [];

  for (const repo of repoEvidence) {
    const evidence = [];

    evidence.push(
      repo.signals.tests.hasTests
        ? `${repo.repo.name}: tests detected (${repo.signals.tests.testFileCount} files).`
        : `${repo.repo.name}: no tests detected.`
    );

    evidence.push(
      repo.signals.readme.present
        ? `${repo.repo.name}: README length ${repo.signals.readme.length} chars.`
        : `${repo.repo.name}: missing README in repository root.`
    );

    evidence.push(
      `${repo.repo.name}: ${repo.signals.commitMetrics.recentCommits90d} commits in last 90 days.`
    );

    highlights.push(...evidence);
  }

  return highlights;
}

function extractFirstJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  try {
    return JSON.parse(text);
  } catch (_err) {
    // Continue with extraction strategy.
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (_err) {
    return null;
  }
}

function buildPrompt({
  profile,
  roleConfig,
  context,
  contextLinks,
  externalContext,
  repoEvidence,
  profileScores,
}) {
  const guidance = context && context.trim() ? context.trim() : "No extra context provided.";
  const contextLinksSummary =
    Array.isArray(contextLinks) && contextLinks.length > 0
      ? JSON.stringify(contextLinks, null, 2)
      : "No external context links provided.";

  const externalContextSummary =
    Array.isArray(externalContext) && externalContext.length > 0
      ? JSON.stringify(
          externalContext.map((entry) => ({
            label: entry.label,
            url: entry.url,
            finalUrl: entry.finalUrl,
            reachable: entry.reachable,
            restricted: entry.restricted,
            title: entry.title,
            description: entry.description,
            heading: entry.heading,
            snippet: entry.snippet,
            note: entry.note,
          })),
          null,
          2
        )
      : "No external context fetch results available.";

  const externalContextRecommendationSummary =
    buildExternalContextRecommendationSummary(externalContext);

  const compactRepoEvidence = repoEvidence.map((entry) => ({
    repo: entry.repo.name,
    selectedBecause: entry.selection.justification,
    deterministicSignals: {
      readmePresent: entry.signals.readme.present,
      readmeLength: entry.signals.readme.length,
      testsDetected: entry.signals.tests.hasTests,
      testFiles: entry.signals.tests.testFileCount,
      locEstimate: entry.signals.locEstimate,
      totalFiles: entry.signals.totalFiles,
      totalDirs: entry.signals.totalDirs,
      recentCommits90d: entry.signals.commitMetrics.recentCommits90d,
      totalCommits: entry.signals.commitMetrics.totalCommits,
      topLevel: entry.signals.topLevel,
    },
    deterministicScores: entry.scores,
  }));

  return `
You are a senior software engineer writing a hiring-ready review.
Use deterministic evidence and fetched external context exactly as provided. Do not invent measurements.

Role focus:
${roleConfig.label}
Role weighting:
${JSON.stringify(roleConfig.weights)}
Role impact note:
${roleConfig.impactNote}

Extra context from user:
${guidance}

External context links from user:
${contextLinksSummary}

External context fetch results (public-page fetch only):
${externalContextSummary}

External context recommendation cues:
${JSON.stringify(externalContextRecommendationSummary, null, 2)}

Candidate profile:
${JSON.stringify(profile, null, 2)}

Deterministic repo evidence:
${JSON.stringify(compactRepoEvidence, null, 2)}

Deterministic profile scores:
${JSON.stringify(profileScores, null, 2)}

Return ONLY valid JSON with this exact schema:
{
  "summary": "string (2-4 sentences executive summary)",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "technicalHighlights": ["string"],
  "growthAreas": ["string"],
  "repoFindings": [
    {
      "repo": "string",
      "projectIntent": "string",
      "architectureSignal": "string",
      "risk": "string"
    }
  ],
  "externalContextSignals": ["string"],
  "hiringRecommendation": {
    "decision": "Strong Hire | Interview | Not a fit",
    "reasoning": "string",
    "senioritySignal": "string",
    "roleFit": ["string"]
  },
  "evaluationModeBlurb": "string (3-4 sentence intro, must mention how context box input affected interpretation)",
  "improvementChecklist": ["string"],
  "roleImpact": "string"
}

Rules:
- Every major claim must tie back to explicit evidence.
- Mention missing evidence directly when applicable.
- Keep writing concrete and recruiter-readable.
- Avoid generic praise.
- Hiring recommendation reasoning must explicitly reference external context results when available.
- In hiringRecommendation.reasoning, include one sentence prefixed with "External context:" that explains how external links changed (or did not change) the decision.
- If external links are restricted/unreachable, state that limitation and fall back to GitHub evidence.
- evaluationModeBlurb must be exactly 3-4 sentences and explicitly mention how user context changed analysis (or explicitly state that no context was provided).
`.trim();
}
async function callGemini(prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  const parsed = extractFirstJsonObject(text);
  if (!parsed) {
    throw new Error("Gemini response could not be parsed as JSON.");
  }

  return parsed;
}

function defaultDecisionFromScore(overallScore) {
  if (overallScore >= 78) return "Strong Hire";
  if (overallScore >= 60) return "Interview";
  return "Not a fit";
}

function normalizeRecommendation(recommendation, overallScore) {
  const fallbackDecision = defaultDecisionFromScore(overallScore);

  const decision =
    recommendation &&
    typeof recommendation.decision === "string" &&
    ["strong hire", "interview", "not a fit"].includes(recommendation.decision.trim().toLowerCase())
      ? recommendation.decision
      : fallbackDecision;

  const roleFit = Array.isArray(recommendation?.roleFit)
    ? recommendation.roleFit
    : ["Needs deeper role-matched project evidence."];

  return {
    decision,
    roleFit,
    senioritySignal:
      typeof recommendation?.senioritySignal === "string"
        ? recommendation.senioritySignal
        : "Seniority signal inferred from repository quality and activity patterns.",
    reasoning:
      typeof recommendation?.reasoning === "string"
        ? recommendation.reasoning
        : "Recommendation defaults to deterministic score thresholds due to limited AI response quality.",
  };
}

function buildFallbackReport({ profileScores, roleConfig, context, repoEvidence, contextLinks, externalContext }) {
  const strengths = [];
  const weaknesses = [];

  if (profileScores.codeOrganization >= 65) {
    strengths.push("Repository structure is generally organized and readable.");
  } else {
    weaknesses.push("Repository organization is uneven across projects.");
  }

  if (profileScores.projectMaturity >= 65) {
    strengths.push("Project maturity signals are present (docs, scope, or history depth).");
  } else {
    weaknesses.push("Project maturity is limited by weak documentation or sparse history.");
  }

  if (profileScores.consistencyActivity >= 65) {
    strengths.push("Recent activity shows consistent project maintenance.");
  } else {
    weaknesses.push("Activity consistency is low across selected repositories.");
  }

  const evidenceHighlights = buildEvidenceHighlights(repoEvidence).slice(0, 6);
  const externalSignals = buildExternalContextSignals(externalContext);
  const hasContextLinks = Array.isArray(contextLinks) && contextLinks.length > 0;
  const externalContextSummary = buildExternalContextRecommendationSummary(externalContext);
  const contextLinkNote = hasContextLinks ? externalContextSummary.note : "";
  const externalRoleFitHighlights = hasContextLinks ? externalContextSummary.highlights.slice(0, 1) : [];

  return {
    summary:
      "Deterministic analysis completed successfully. AI synthesis is unavailable, so this report prioritizes measured repository signals, fetched public context links, and transparent scoring.",
    strengths,
    weaknesses,
    technicalHighlights: evidenceHighlights,
    growthAreas: [
      "Increase test coverage signals across representative repositories.",
      "Strengthen README depth with setup, architecture, and validation details.",
      "Maintain steadier commit cadence on key repositories.",
    ],
    repoFindings: repoEvidence.map((entry) => ({
      repo: entry.repo.name,
      projectIntent: entry.repo.description || "Project intent not clearly documented.",
      architectureSignal: entry.signals.tests.hasTests
        ? "Testing patterns are present, suggesting deliberate project structure."
        : "Testing patterns are missing, reducing confidence in architecture rigor.",
      risk:
        entry.signals.commitMetrics.recentCommits90d === 0
          ? "No recent commit activity detected in the last 90 days."
          : "Primary risk is limited deterministic depth without full runtime validation.",
    })),
    externalContextSignals: externalSignals,
    evaluationModeBlurb: buildEvaluationModeBlurb({
      roleConfig,
      context,
      repoEvidence,
      profileScores,
    }),
    hiringRecommendation: {
      decision: defaultDecisionFromScore(profileScores.overall),
      roleFit: dedupeRecommendationLines(
        [
          roleConfig.label + " evaluation was applied using deterministic weighting.",
          ...externalRoleFitHighlights,
          contextLinkNote,
        ].filter(Boolean)
      ),
      senioritySignal:
        "Seniority signal estimated from measurable repository structure and activity.",
      reasoning: [
        "Recommendation is directly derived from deterministic profile scores, role weighting, and public external-context signals.",
        hasContextLinks ? "External context: " + contextLinkNote : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
    improvementChecklist: [
      "Add test suites in primary repositories and expose test commands in README.",
      "Document architecture and deployment decisions in repository root docs.",
      "Sustain regular commit cadence across production-intent projects.",
    ],
    roleImpact: [roleConfig.impactNote, contextLinkNote].filter(Boolean).join(" "),
  };
}
async function analyzeRepositoryDeterministically(selectedEntry, fallbackOwner) {
  const repo = selectedEntry.repo;
  const owner = repo?.owner?.login || fallbackOwner;
  const readmePromise = fetchReadme(owner, repo.name).catch(() => null);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hirescope-"));
  const clonePath = path.join(tempRoot, repo.name.replace(/[^a-zA-Z0-9._-]/g, "_"));

  let structure = createEmptyRepoStructure();
  let cloneSucceeded = false;

  try {
    const repoSizeKb = Number(repo.size || 0);

    if (repoSizeKb <= 250000) {
      await cloneRepository(repo.clone_url, clonePath);
      cloneSucceeded = true;
      structure = await inspectClonedRepository(clonePath);
    }
  } catch (_error) {
    cloneSucceeded = false;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  const readmeText = await readmePromise;
  if (!structure.readme.present && readmeText) {
    structure.readme.present = true;
    structure.readme.length = readmeText.length;
  }

  structure.tests.hasTests =
    structure.tests.hasTests ||
    structure.tests.testDirectoryCount > 0 ||
    structure.tests.testFileCount > 0;

  const signals = {
    topLevel: structure.topLevel,
    treePreview: structure.treePreview,
    totalFiles: structure.totalFiles,
    totalDirs: structure.totalDirs,
    sourceFileCount: structure.sourceFileCount,
    locEstimate: structure.locEstimate,
    readme: structure.readme,
    tests: structure.tests,
    licensePresent: structure.licensePresent,
    commitMetrics: selectedEntry.commitMetrics,
    recencyDays: selectedEntry.factors.recencyDays,
    hasIssues: Boolean(repo.has_issues),
    hasWiki: Boolean(repo.has_wiki),
    archived: Boolean(repo.archived),
    cloneSucceeded,
  };

  const scores = calculateRepoScores(signals);

  return {
    repo: {
      name: repo.name,
      htmlUrl: repo.html_url,
      description: repo.description || "",
      language: repo.language || "Unknown",
      stars: repo.stargazers_count,
      updatedAt: repo.updated_at,
    },
    selection: {
      selectionScore: selectedEntry.selectionScore,
      baseScore: selectedEntry.baseScore,
      justification: selectedEntry.justification,
      factors: selectedEntry.factors,
    },
    signals,
    scores,
  };
}

async function buildProfileAnalysis(username) {
  const [user, repos] = await Promise.all([
    fetchGitHub(`https://api.github.com/users/${username}`),
    fetchGitHub(`https://api.github.com/users/${username}/repos?per_page=100&sort=updated`),
  ]);

  const selection = await pickReposForDeepAnalysis(repos);

  const repoEvidence = await mapWithConcurrency(selection.selected, 2, (entry) =>
    analyzeRepositoryDeterministically(entry, username)
  );

  return {
    profile: {
      username: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      bio: user.bio,
      followers: user.followers,
      following: user.following,
      publicRepos: user.public_repos,
      htmlUrl: user.html_url,
      company: user.company,
      location: user.location,
      blog: user.blog,
    },
    evidence: {
      selectionMeta: selection.meta,
      repos: repoEvidence,
    },
  };
}

function analysisRateLimiter(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();

  const current = rateLimitStore.get(key);

  if (!current || now - current.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(key, { windowStart: now, count: 1 });
    return next();
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: "Too many analysis requests. Please wait a minute and try again.",
    });
  }

  current.count += 1;
  return next();
}

app.post("/api/analyze", analysisRateLimiter, async (req, res, next) => {
  try {
    const username = parseGithubUsername(req.body?.username);
    const context = typeof req.body?.context === "string" ? req.body.context : "";
    const role = normalizeRole(req.body?.role);
    const roleOther = normalizeOtherRole(req.body?.roleOther);
    const contextLinks = normalizeContextLinks(req.body?.contextLinks);
    const roleConfig = buildRoleConfig(role, roleOther);

    if (!username) {
      return res.status(400).json({
        error: "Please provide a valid GitHub username or profile URL.",
      });
    }

    const contextKey = context.trim().toLowerCase().slice(0, 180);
    const roleOtherKey = roleOther.toLowerCase();
    const contextLinksKey = contextLinks
      .map((entry) => entry.label + ":" + entry.url)
      .join("|")
      .toLowerCase()
      .slice(0, 220);
    const resultCacheKey =
      username + "|" + role + "|" + roleOtherKey + "|" + contextKey + "|" + contextLinksKey;
    const cachedResult = getCached(resultCache, resultCacheKey, RESULT_CACHE_TTL_MS);

    if (cachedResult) {
      return res.json({
        ...cachedResult,
        cache: { source: "analysis-cache", hit: true },
      });
    }

    let baseProfileAnalysis = getCached(profileCache, username, PROFILE_CACHE_TTL_MS);
    const usedProfileCache = Boolean(baseProfileAnalysis);

    if (!baseProfileAnalysis) {
      baseProfileAnalysis = await buildProfileAnalysis(username);
      setCached(profileCache, username, baseProfileAnalysis);
    }

    const profileScores = aggregateProfileScores(baseProfileAnalysis.evidence.repos, roleConfig);
    const externalContext = await resolveExternalContext(contextLinks);

    let aiReport = null;
    let aiError = null;

    if (GEMINI_API_KEY) {
      const prompt = buildPrompt({
        profile: baseProfileAnalysis.profile,
        roleConfig,
        context,
        contextLinks,
        externalContext,
        repoEvidence: baseProfileAnalysis.evidence.repos,
        profileScores,
      });

      try {
        aiReport = await callGemini(prompt);
      } catch (error) {
        aiError =
          error && typeof error.message === "string"
            ? error.message
            : "AI synthesis unavailable.";
      }
    } else {
      aiError = "GEMINI_API_KEY is missing; generated deterministic fallback report.";
    }

    if (!aiReport) {
      aiReport = buildFallbackReport({
        profileScores,
        roleConfig,
        context,
        repoEvidence: baseProfileAnalysis.evidence.repos,
        contextLinks,
        externalContext,
      });
    }

    const normalizedRecommendation = normalizeRecommendation(
      aiReport.hiringRecommendation || aiReport.recommendation,
      profileScores.overall
    );
    const inferredRoleFitLines = inferRoleFitLinesFromRepoEvidence(baseProfileAnalysis.evidence.repos);

    const externalContextSummary =
      contextLinks.length > 0 ? buildExternalContextRecommendationSummary(externalContext) : null;
    const externalContextRecommendation = externalContextSummary?.note || "";
    const hasExternalRoleFit = Array.isArray(normalizedRecommendation.roleFit)
      ? normalizedRecommendation.roleFit.some((item) => /external context|external links|linkedin/i.test(item))
      : false;

    const recommendation = {
      ...normalizedRecommendation,
      roleFit: dedupeRecommendationLines(
        [
          ...(normalizedRecommendation.roleFit || []),
          ...inferredRoleFitLines,
          ...(!hasExternalRoleFit ? (externalContextSummary?.highlights || []).slice(0, 1) : []),
          !hasExternalRoleFit ? externalContextRecommendation : "",
        ].filter(Boolean)
      ),
      reasoning: mergeRecommendationReasoning(normalizedRecommendation.reasoning, externalContextRecommendation),
    };
    const fallbackEvaluationModeBlurb = buildEvaluationModeBlurb({
      roleConfig,
      context,
      repoEvidence: baseProfileAnalysis.evidence.repos,
      profileScores,
    });

    const responsePayload = {
      profile: baseProfileAnalysis.profile,
      role: {
        selectedRole: role,
        customRole: roleOther || null,
        label: roleConfig.label,
        weights: roleConfig.weights,
        impactNote: roleConfig.impactNote,
      },
      sampledRepos: baseProfileAnalysis.evidence.repos.map((entry) => ({
        name: entry.repo.name,
        htmlUrl: entry.repo.htmlUrl,
        stars: entry.repo.stars,
        language: entry.repo.language,
        updatedAt: entry.repo.updatedAt,
      })),
      evidence: {
        selectionMeta: baseProfileAnalysis.evidence.selectionMeta,
        repos: baseProfileAnalysis.evidence.repos,
      },
      report: {
        summary:
          typeof aiReport.summary === "string"
            ? aiReport.summary
            : "No executive summary returned.",
        scores: profileScores,
        strengths: Array.isArray(aiReport.strengths) ? aiReport.strengths : [],
        gaps: Array.isArray(aiReport.weaknesses)
          ? aiReport.weaknesses
          : Array.isArray(aiReport.gaps)
            ? aiReport.gaps
            : [],
        technicalHighlights: Array.isArray(aiReport.technicalHighlights)
          ? aiReport.technicalHighlights
          : buildEvidenceHighlights(baseProfileAnalysis.evidence.repos).slice(0, 8),
        growthAreas: Array.isArray(aiReport.growthAreas) ? aiReport.growthAreas : [],
        repoFindings: Array.isArray(aiReport.repoFindings)
          ? aiReport.repoFindings
          : baseProfileAnalysis.evidence.repos.map((entry) => ({
              repo: entry.repo.name,
              qualityScore: entry.scores.overall,
              projectIntent: entry.repo.description || "Project intent not clearly documented.",
              architectureSignal: entry.signals.tests.hasTests
                ? "Repository shows testing signals and structured source layout."
                : "Repository has limited testing signals, reducing architecture confidence.",
              risk:
                entry.signals.commitMetrics.recentCommits90d === 0
                  ? "No commit activity in last 90 days."
                  : "Primary risk is uneven maturity across repository evidence.",
            })),
        externalContextSignals:
          contextLinks.length > 0
            ? Array.isArray(aiReport.externalContextSignals) && aiReport.externalContextSignals.length > 0
              ? aiReport.externalContextSignals
              : buildExternalContextSignals(externalContext)
            : [],
        evaluationModeBlurb: normalizeEvaluationModeBlurb(
          aiReport.evaluationModeBlurb,
          fallbackEvaluationModeBlurb,
          context
        ),
        recommendation,
        improvementChecklist: Array.isArray(aiReport.improvementChecklist)
          ? aiReport.improvementChecklist
          : [],
        roleImpact: [
          typeof aiReport.roleImpact === "string" && aiReport.roleImpact.trim()
            ? aiReport.roleImpact
            : roleConfig.impactNote,
          contextLinks.length > 0 ? externalContextRecommendation : "",
        ]
          .filter(Boolean)
          .join(" "),
      },
      diagnostics: {
        aiFallbackUsed: Boolean(aiError),
        aiMessage: aiError,
      },
      inputContext: {
        extraContext: context,
        contextLinks,
        externalContext,
      },
      cache: {
        source: usedProfileCache ? "profile-cache" : "fresh",
        hit: false,
      },
    };

    setCached(resultCache, resultCacheKey, responsePayload);

    return res.json(responsePayload);
  } catch (error) {
    return next(error);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, _req, res, _next) => {
  const message =
    err && typeof err.message === "string"
      ? err.message
      : "Unexpected error while analyzing profile.";

  const status = err && Number.isInteger(err.status) ? err.status : 500;

  res.status(status).json({
    error: message,
  });
});

async function warmProfileCache() {
  if (process.env.WARM_CACHE !== "true") return;

  for (const username of DEMO_PROFILES) {
    try {
      const profileAnalysis = await buildProfileAnalysis(username);
      setCached(profileCache, username, profileAnalysis);
      // eslint-disable-next-line no-console
      console.log(`Warm cache: ${username}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(`Warm cache failed for ${username}: ${error.message}`);
    }
  }
}

app.listen(PORT, async () => {
  // eslint-disable-next-line no-console
  console.log(`HireScope is running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(
    GITHUB_TOKEN
      ? `GitHub API auth enabled via ${githubTokenSource}.`
      : "GitHub API auth not configured. Set GITHUB_TOKEN to avoid rate limits."
  );
  warmProfileCache().catch(() => {});
});
