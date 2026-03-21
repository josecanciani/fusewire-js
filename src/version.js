import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const HASH_LENGTH = 12;
const EXTENSIONS = [".html", ".css", ".js"];

const cache = new Map();

/**
 * Compute a version string for a component by hashing the contents of its
 * `.html`, `.css`, and `.js` files. The result is a 12-character hex prefix of
 * a SHA-256 digest. Missing (optional) files are silently skipped.
 *
 * Results are cached in memory. Call {@link invalidateVersion} or
 * {@link invalidateAll} to clear the cache when files change.
 *
 * @param {string} componentDir Absolute path to the component directory.
 * @param {string} baseName     The component file base name (e.g. "ServerTime").
 * @returns {Promise<string>}   12-char hex version string.
 */
export async function getComponentVersion(componentDir, baseName) {
  const key = join(componentDir, baseName);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const hash = createHash("sha256");
  let hasContent = false;

  for (const ext of EXTENSIONS) {
    try {
      hash.update(await readFile(join(componentDir, baseName + ext)));
      hasContent = true;
    } catch {
      // Optional file, skip.
    }
  }

  if (!hasContent) {
    throw new Error(`No component files found for "${baseName}" in ${componentDir}`);
  }

  const version = hash.digest("hex").slice(0, HASH_LENGTH);
  cache.set(key, version);
  return version;
}

/**
 * Remove the cached version for a single component.
 *
 * @param {string} componentDir Absolute path to the component directory.
 * @param {string} baseName     The component file base name.
 */
export function invalidateVersion(componentDir, baseName) {
  cache.delete(join(componentDir, baseName));
}

/** Clear all cached versions. */
export function invalidateAll() {
  cache.clear();
}
