/**
 * Helpers shared by the v14.368 package-index proxy and the legacy
 * `/api/fvtt/packages` compatibility endpoint.
 */

const GITHUB_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.github.com"
]);

const GITLAB_HOSTS = new Set(["gitlab.com"]);

const URL_KEYS = new Set(["manifest", "download"]);

function matchesHost(hostname, hosts) {
  return hosts.has(hostname) || [...hosts].some(host => hostname.endsWith(`.${host}`));
}

/**
 * Return the proxy family for an upstream URL, or null for URLs which should
 * remain direct (for example R2 package downloads).
 */
export function getProxyKind(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (matchesHost(url.hostname, GITHUB_HOSTS)) return "github";
    if (matchesHost(url.hostname, GITLAB_HOSTS)) return "gitlab";
  } catch {
    // A manifest can be a relative path; leave invalid/non-HTTP values alone.
  }
  return null;
}

/**
 * Convert a GitHub/GitLab URL to this service's allow-listed proxy route.
 */
export function toProxyUrl(value, proxyBase) {
  const kind = getProxyKind(value);
  if (!kind || typeof proxyBase !== "string" || !proxyBase) return value;
  const base = proxyBase.replace(/\/+$/, "");
  if (value.startsWith(`${base}/proxy/`)) return value;
  return `${base}/proxy/${kind}/${value}`;
}

/**
 * Recursively rewrite only package transport URLs. Package homepages and
 * author URLs must not be proxied.
 */
export function rewritePackageUrls(value, { proxyBase, detailsProxy } = {}) {
  if (Array.isArray(value)) return value.map(item => rewritePackageUrls(item, { proxyBase, detailsProxy }));
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "details" && typeof item === "string" && detailsProxy) {
      result[key] = detailsProxy;
    } else if (URL_KEYS.has(key) && typeof item === "string") {
      result[key] = toProxyUrl(item, proxyBase);
    } else {
      result[key] = rewritePackageUrls(item, { proxyBase, detailsProxy });
    }
  }
  return result;
}

export function getOwnedPackageNames(entitlements) {
  const names = new Set();
  for (const item of [...(entitlements?.purchases ?? []), ...(entitlements?.subscriptions ?? [])]) {
    if (item?.name) names.add(item.name);
  }
  return names;
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

function compareVersion(a, b) {
  const left = parseVersion(a) ?? [0, 0];
  const right = parseVersion(b) ?? [0, 0];
  return left[0] - right[0] || left[1] - right[1];
}

function selectCompatibilitySegment(entry, release) {
  const segments = Array.isArray(entry.compatibility) ? entry.compatibility : [];
  if (!segments.length) return null;
  const selected = segments.find(segment => {
    const fromOk = !segment.from || compareVersion(release, segment.from) >= 0;
    const toOk = !segment.to || compareVersion(release, segment.to) <= 0;
    return fromOk && toOk;
  });
  return selected ?? segments.at(-1);
}

/**
 * Adapt the v14.368 public index to the response shape used by the older
 * package patches shipped before v14.367.
 */
export function toLegacyRepositoryResponse(index, ownedNames = new Set(), type = "module", release = "") {
  const owned = ownedNames instanceof Set ? ownedNames : new Set(ownedNames ?? []);
  const packages = [];

  for (const entry of index?.packages ?? []) {
    if (entry?.type !== type || !entry.id) continue;
    const segment = selectCompatibilitySegment(entry, release);
    const normalized = segment ? {...entry, ...segment} : entry;
    const systems = (normalized.relationships?.systems ?? normalized.requires ?? [])
      .map(system => typeof system === "string" ? system : system?.id)
      .filter(Boolean);
    const compatibility = segment
      ? {minimum: segment.from, verified: segment.verified, maximum: segment.to}
      : (entry.compatibility ?? {});
    const provider = entry.provider ?? entry.author;
    const isProtected = Boolean(entry.protected ?? entry.premium);
    packages.push({
      name: entry.id,
      title: entry.title ?? entry.id,
      description: entry.description ?? entry.summary ?? "",
      changelog: normalized.changelog ?? normalized.notes ?? "",
      author: entry.authors?.[0]?.name ?? provider?.name ?? provider ?? "",
      url: entry.url ?? "",
      version: {
        version: normalized.version ?? "0",
        notes: normalized.changelog ?? normalized.notes ?? "",
        manifest: normalized.manifest ?? "",
        required_core_version: compatibility.minimum,
        compatible_core_version: compatibility.verified,
        maximum_core_version: compatibility.maximum
      },
      is_protected: isProtected,
      requires: systems,
      tags: entry.tags ?? [],
      is_exclusive: Boolean(entry.exclusive),
      owned: isProtected && owned.has(entry.id)
    });
  }

  return {
    packages,
    owned: [...owned]
  };
}
