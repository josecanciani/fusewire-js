import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getComponentVersion, invalidateVersion, invalidateAll } from "../src/version.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "fusewire-version-"));
}

describe("getComponentVersion", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTmpDir();
    invalidateAll();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns a 12-character hex string", async () => {
    await writeFile(join(dir, "Foo.html"), "<p>hello</p>");
    const version = await getComponentVersion(dir, "Foo");
    assert.match(version, /^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same content", async () => {
    await writeFile(join(dir, "Foo.html"), "<p>hello</p>");
    const v1 = await getComponentVersion(dir, "Foo");
    invalidateVersion(dir, "Foo");
    const v2 = await getComponentVersion(dir, "Foo");
    assert.equal(v1, v2);
  });

  it("changes when file content changes", async () => {
    await writeFile(join(dir, "Foo.html"), "<p>v1</p>");
    const v1 = await getComponentVersion(dir, "Foo");
    invalidateVersion(dir, "Foo");
    await writeFile(join(dir, "Foo.html"), "<p>v2</p>");
    const v2 = await getComponentVersion(dir, "Foo");
    assert.notEqual(v1, v2);
  });

  it("hashes all three file types together", async () => {
    await writeFile(join(dir, "Bar.html"), "<p>bar</p>");
    await writeFile(join(dir, "Bar.css"), ".bar {}");
    await writeFile(join(dir, "Bar.js"), "export default class {}");

    const expected = createHash("sha256")
      .update(Buffer.from("<p>bar</p>"))
      .update(Buffer.from(".bar {}"))
      .update(Buffer.from("export default class {}"))
      .digest("hex")
      .slice(0, 12);

    const version = await getComponentVersion(dir, "Bar");
    assert.equal(version, expected);
  });

  it("skips missing optional files", async () => {
    await writeFile(join(dir, "Only.html"), "<p>only html</p>");

    const expected = createHash("sha256")
      .update(Buffer.from("<p>only html</p>"))
      .digest("hex")
      .slice(0, 12);

    const version = await getComponentVersion(dir, "Only");
    assert.equal(version, expected);
  });

  it("throws when no component files exist", async () => {
    await assert.rejects(() => getComponentVersion(dir, "Missing"), /No component files found/);
  });

  it("caches the result", async () => {
    await writeFile(join(dir, "Cached.html"), "original");
    const v1 = await getComponentVersion(dir, "Cached");

    // Overwrite the file -- cached value should still be returned.
    await writeFile(join(dir, "Cached.html"), "changed");
    const v2 = await getComponentVersion(dir, "Cached");
    assert.equal(v1, v2);
  });
});

describe("invalidateVersion", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTmpDir();
    invalidateAll();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("clears the cache for one component", async () => {
    await writeFile(join(dir, "A.html"), "a");
    await writeFile(join(dir, "B.html"), "b");

    const a1 = await getComponentVersion(dir, "A");
    await getComponentVersion(dir, "B");

    await writeFile(join(dir, "A.html"), "a-changed");
    invalidateVersion(dir, "A");

    const a2 = await getComponentVersion(dir, "A");
    assert.notEqual(a1, a2);
  });
});

describe("invalidateAll", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTmpDir();
    invalidateAll();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("clears all cached versions", async () => {
    await writeFile(join(dir, "X.html"), "x");
    const v1 = await getComponentVersion(dir, "X");

    await writeFile(join(dir, "X.html"), "x-changed");
    invalidateAll();

    const v2 = await getComponentVersion(dir, "X");
    assert.notEqual(v1, v2);
  });
});
