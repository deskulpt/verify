import assert from "node:assert/strict";
import { test } from "node:test";
import { normName, sourcesFor } from "./server.mjs";

test("names match across suffix and punctuation variants", () => {
  assert.equal(normName("Infosys Ltd."), normName("INFOSYS LIMITED"));
  assert.equal(normName("Shopify Inc."), "shopify");
  assert.notEqual(normName("Infosys BPM Ltd"), normName("Infosys Limited"));
});

test("sources filter by country and exporter flag", () => {
  const ids = (f) => sourcesFor(f).map((s) => s.id);
  assert.ok(ids({ country: "CA" }).includes("cbr"));
  assert.ok(!ids({ country: "CA" }).includes("mca-name"));
  assert.ok(!ids({ country: "IN" }).includes("dgft-iec"));
  assert.ok(ids({ country: "IN", exporter: true }).includes("dgft-iec"));
  assert.ok(ids({ country: "IN" }).includes("gleif"));
});

test("judge: name plus matching number verifies, wrong number fails", async () => {
  const { judge } = await import("./server.mjs");
  const rec = { legalName: "INFOSYS LIMITED", ids: [{ type: "LEI", value: "335800TYLGG93MM7PR89" }, { type: "REG", value: "L85110KA1981PLC013115" }] };
  assert.equal(judge({ name: "Infosys Ltd", regNumber: "L85110KA1981PLC013115" }, [rec]).verified, true);
  assert.equal(judge({ name: "Infosys Ltd", regNumber: "L00000KA1981PLC000000" }, [rec]).verified, false);
  assert.equal(judge({ name: "Wipro Ltd" }, [rec]).verified, false);
  // a VAT number can't fail a record that holds no VAT
  assert.equal(judge({ name: "Infosys Ltd", taxId: "XX123" }, [rec]).verified, true);
});

test("judge: VAT prefix and name withheld by registry", async () => {
  const { judge } = await import("./server.mjs");
  const vies = { legalName: null, ids: [{ type: "VAT", value: "DE129273398" }] };
  assert.equal(judge({ name: "SAP SE", taxId: "129273398" }, [vies]).verified, true);
  assert.equal(judge({ name: "SAP SE", taxId: "DE999999999" }, [vies]).verified, false);
});

test("judge: alias match (GLEIF English name beside Arabic legal name)", async () => {
  const { judge } = await import("./server.mjs");
  const r = { legalName: "شركة مجموعة الامارات للاتصالات ش.م.ع.", aliases: ["Emirates Telecommunications Group Company PJSC"], ids: [] };
  assert.equal(judge({ name: "Emirates Telecommunications Group Company P.J.S.C." }, [r]).verified, true);
});

test("EU region sources apply to member states only", () => {
  const ids = (f) => sourcesFor(f).map((s) => s.id);
  assert.ok(ids({ country: "DE" }).includes("vies"));
  assert.ok(!ids({ country: "US" }).includes("vies"));
  assert.ok(ids({ country: "FR" }).includes("fr-sirene"));
  assert.ok(!ids({ country: "DE" }).includes("fr-sirene"));
});

test("inactive record is reported, not verified", async () => {
  const { judge, isActive } = await import("./server.mjs");
  assert.equal(isActive({ status: "INACTIVE" }), false);
  assert.equal(isActive({ status: "ACTIVE" }), true);
  assert.equal(isActive({ status: "BAIXADA" }), false);
  assert.equal(isActive({ status: "incorporated in DE" }), null);
  const dead = { legalName: "Acme Ltd", status: "Dissolved", ids: [] };
  const live = { legalName: "ACME LIMITED", status: "Active", ids: [] };
  assert.equal(judge({ name: "Acme Ltd" }, [dead]).outcome, "inactive");
  assert.equal(judge({ name: "Acme Ltd" }, [dead, live]).outcome, "verified");
});

test("summary confidence", async () => {
  const { summarize } = await import("./server.mjs");
  const v = (id, idMatched = false) => ({ id, mode: "auto", outcome: "verified", idMatched });
  assert.equal(summarize([v("a")]).confidence, "medium");
  assert.equal(summarize([v("a"), v("b")]).confidence, "high");
  assert.equal(summarize([v("a", true)]).confidence, "high");
  assert.equal(summarize([{ id: "a", mode: "auto", outcome: "inactive" }]).status, "inactive");
  assert.equal(summarize([{ id: "a", mode: "auto", outcome: "not_found" }]).status, "unverified");
});

test("trademark sources support but never verify on their own", async () => {
  const { summarize } = await import("./server.mjs");
  const tm = { id: "euipo-tm", mode: "auto", supporting: true, outcome: "verified" };
  const s = summarize([tm, { id: "x", mode: "auto", outcome: "inactive" }]);
  assert.equal(s.status, "inactive");
  assert.deepEqual(s.verifiedBy, []);
  assert.deepEqual(s.trademarksIn, ["euipo-tm"]);
  assert.equal(summarize([{ ...tm, outcome: "inactive" }]).status, "unverified");
});

test("idMatched only when a given number actually matched", async () => {
  const { judge } = await import("./server.mjs");
  const rec = { legalName: "Acme", status: "Active", ids: [{ type: "LEI", value: "X" }] };
  assert.equal(judge({ name: "Acme", taxId: "DE123" }, [rec]).idMatched, false);
});
