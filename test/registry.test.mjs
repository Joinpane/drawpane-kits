/** The rules for kits hosted here, on a kit that follows them and one that doesn't. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkKit, entryOf, readKits } from "../scripts/registry.mjs";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;

test("a kit that follows the rules passes", async () => {
  const [kit] = await readKits(`${fixtures}good`);
  assert.deepEqual(await checkKit(kit), []);
});

test("a kit is held to its licence, attribution, hash, size and cover", async () => {
  const [kit] = await readKits(`${fixtures}bad`);
  const problems = (await checkKit(kit)).join("\n");
  assert.match(problems, /attribution must name the kit/);
  assert.match(problems, /attribution must name the licence \(CC BY 4.0\)/);
  assert.match(problems, /attribution must link the licence/);
  assert.match(problems, /attribution must say the kit was converted/);
  assert.match(problems, /22 bytes, kit.json says 7/);
  assert.match(problems, /sha256 is/);
  assert.match(problems, /cover: 100 x 50/);
});

test("a licence outside the allowed list fails the schema", async () => {
  const [kit] = await readKits(`${fixtures}good`);
  const problems = await checkKit(
    { ...kit, kit: { ...kit.kit, licence: { spdx: "CC-BY-NC-4.0", url: "https://example.com" } } },
    { files: false },
  );
  assert.ok(problems.some((p) => p.includes("/licence/spdx")));
});

test("ids can't take Penpot's prefix or differ from their folder", async () => {
  const [kit] = await readKits(`${fixtures}good`);
  const problems = await checkKit({ ...kit, kit: { ...kit.kit, id: "penpot-x" } }, { files: false });
  assert.ok(problems.some((p) => p.includes("match its folder")));
  assert.ok(problems.some((p) => p.includes("Penpot's")));
});

test("an index entry points at files relative to index.json", async () => {
  const [{ kit }] = await readKits(`${fixtures}good`);
  const entry = entryOf(kit, "kits/example-kit");
  assert.equal(entry.provider, "drawpane");
  assert.equal(entry.file.url, "kits/example-kit/kit.penpot");
  assert.equal(entry.cover, "kits/example-kit/cover.png");
  assert.equal(entry.licence.spdx, "CC-BY-4.0");
});
