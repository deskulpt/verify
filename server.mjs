// Biz Verify: one form, auto-verifies against open APIs, lists manual sources for the rest.
// Run: node server.mjs  (PORT defaults to 3000; set CONTACT_EMAIL for SEC EDGAR's fair-access rule)
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const page = readFileSync(new URL("./public/index.html", import.meta.url));

// Legal-form words that vary between a form and a registry ("Ltd" vs "Limited", "a.s.", "GmbH")
const SUFFIXES =
  /\b(private|pvt|limited|ltd|llp|llc|lp|plc|inc|incorporated|corp|corporation|co|company|ltee|limitee|gmbh|ag|kg|sa|sas|sarl|spa|srl|bv|nv|oy|oyj|ou|asa|aps|ab|as|a s|s a|s r o|sro|ltda|eireli|me|pte|se|fzco|fze|fz|dmcc|pjsc|p j s c|the)\b/g;
export const normName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
export const normId = (s) => String(s ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

// Sources for this submission: country, its region ("EU") or "*", and any `when` flag the form set.
export const sourcesFor = (form) => {
  const region = config.countries[form.country]?.region;
  return config.sources.filter(
    (s) => s.countries.some((c) => c === "*" || c === form.country || c === region) && (!s.when || form[s.when]),
  );
};

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "user-agent": "BizVerify/0.1", ...init.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const enc = encodeURIComponent;
const join = (...parts) => parts.flat().filter(Boolean).join(", ");

// EUIPO OAuth client-credentials token, cached until shortly before expiry.
let euipoToken = { value: null, until: 0 };
async function euipoAuth() {
  const id = process.env.EUIPO_CLIENT_ID, secret = process.env.EUIPO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("set EUIPO_CLIENT_ID and EUIPO_CLIENT_SECRET (free at dev.euipo.europa.eu)");
  if (Date.now() < euipoToken.until) return { id, token: euipoToken.value };
  const t = await getJson("https://euipo.europa.eu/cas-server-webapp/oidc/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "uid" }),
  });
  euipoToken = { value: t.access_token, until: Date.now() + ((t.expires_in ?? 600) - 60) * 1000 };
  return { id, token: t.access_token };
}

// Each adapter returns candidate records: { legalName, ids: [{type, value}], status, address, url }.
const auto = {
  // Trademarks owned by the business (supporting evidence only; see "supporting" in config).
  async "euipo-tm"(form) {
    const { id, token } = await euipoAuth();
    const core = normName(form.name).replace(/["\\]/g, "");
    // ponytail: case-sensitivity of RSQL "==" is undocumented, so ask for the common casings
    const variants = [...new Set([core, core.toUpperCase(), core.replace(/\b\w/g, (c) => c.toUpperCase())])].map((v) => `"*${v}*"`);
    const q = `applicants.name=in=(${variants.join(",")})`;
    const d = await getJson(`https://api.euipo.europa.eu/trademark-search/trademarks?size=50&query=${enc(q)}`, {
      headers: { authorization: `Bearer ${token}`, "x-ibm-client-id": id },
    });
    return (d?.trademarks ?? []).flatMap((t) =>
      (t.applicants ?? []).map((a) => ({
        legalName: a.name,
        ids: [], // trademark numbers are not company numbers; keep them out of id matching
        status: `Trademark ${t.status ?? "unknown"} · EUTM ${t.applicationNumber}`,
        active: t.status === "REGISTERED",
        address: t.wordMarkSpecification?.verbalElement ? `Mark: ${t.wordMarkSpecification.verbalElement}` : "",
        url: `https://euipo.europa.eu/eSearch/#details/trademarks/${t.applicationNumber}`,
      })),
    );
  },
  async gleif(form) {
    const base = `https://api.gleif.org/api/v1/lei-records?page[size]=50&filter[entity.legalAddress.country]=${form.country}`;
    // legalName is an exact match and fulltext misses suffix variants ("Ltd" vs "Limited"), so ask both
    const queries = form.regNumber
      ? [`&filter[entity.registeredAs]=${enc(form.regNumber)}`]
      : [`&filter[entity.legalName]=${enc(form.name)}`, `&filter[fulltext]=${enc(normName(form.name))}`];
    const pages = await Promise.all(queries.map((q) => getJson(base + q, { headers: { accept: "application/vnd.api+json" } })));
    const seen = new Set();
    return pages
      .flatMap((p) => p?.data ?? [])
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .map(({ attributes: { lei, entity: e } }) => ({
        legalName: e.legalName.name,
        // UAE and other records often hold the legal name in Arabic with the English form here
        aliases: [...e.otherNames, ...e.transliteratedOtherNames].filter((n) => n.type !== "PREVIOUS_LEGAL_NAME").map((n) => n.name),
        ids: [{ type: "LEI", value: lei }, e.registeredAs && { type: "REG", value: e.registeredAs }].filter(Boolean),
        status: e.status,
        address: join(e.legalAddress.addressLines, e.legalAddress.city, e.legalAddress.region, e.legalAddress.postalCode),
        url: `https://search.gleif.org/#/record/${lei}`,
      }));
  },

  async "sec-edgar"(form) {
    if (!process.env.CONTACT_EMAIL) throw new Error("set CONTACT_EMAIL (SEC requires a contact in the User-Agent)");
    const headers = { "user-agent": `BizVerify/0.1 ${process.env.CONTACT_EMAIL}` };
    const cik = /^\d{1,10}$/.test(form.regNumber ?? "") && form.regNumber.padStart(10, "0");
    const ciks = cik
      ? [cik]
      : ((await getJson(`https://efts.sec.gov/LATEST/search-index?keysTyped=${enc(form.name)}`, { headers }))?.hits?.hits ?? [])
          .filter((h) => normName(h._source.entity.replace(/\s*\([^)]*\)\s*$/, "")) === normName(form.name))
          .slice(0, 3)
          .map((h) => h._id.padStart(10, "0"));
    const subs = await Promise.all(ciks.map((c) => getJson(`https://data.sec.gov/submissions/CIK${c}.json`, { headers })));
    return subs.filter(Boolean).map((d) => {
      const a = d.addresses.business;
      return {
        legalName: d.name,
        ids: [{ type: "CIK", value: d.cik }, d.ein && { type: "EIN", value: d.ein }].filter(Boolean),
        status: d.stateOfIncorporation ? `incorporated in ${d.stateOfIncorporation}` : "",
        address: join(a.street1, a.street2, a.city, a.stateOrCountry, a.zipCode),
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${d.cik}`,
      };
    });
  },

  async "ny-dos"(form) {
    const where = form.regNumber ? `dos_id=${enc(`'${form.regNumber.replace(/'/g, "")}'`)}` : `$q=${enc(form.name)}`;
    const rows = await getJson(`https://data.ny.gov/resource/n9v6-gdp6.json?$limit=50&${where}`);
    return (rows ?? []).map((r) => ({
      legalName: r.current_entity_name,
      ids: [{ type: "DOS ID", value: r.dos_id }],
      active: true, // the dataset lists active entities only
      status: join(r.entity_type, r.initial_dos_filing_date && `filed ${r.initial_dos_filing_date.slice(0, 10)}`),
      address: join(r.dos_process_address_1, r.dos_process_city, r.dos_process_state, r.dos_process_zip),
      url: "https://apps.dos.ny.gov/publicInquiry/",
    }));
  },

  async "co-sos"(form) {
    const where = form.regNumber ? `entityid=${enc(`'${form.regNumber.replace(/'/g, "")}'`)}` : `$q=${enc(form.name)}`;
    const rows = await getJson(`https://data.colorado.gov/resource/4ykn-tg5h.json?$limit=50&${where}`);
    return (rows ?? []).map((r) => ({
      legalName: r.entityname,
      ids: [{ type: "CO ID", value: r.entityid }],
      status: join(r.entitystatus, r.jurisdictonofformation && `formed in ${r.jurisdictonofformation}`),
      address: join(r.principaladdress1, r.principalcity, r.principalstate, r.principalzipcode),
      url: `https://www.coloradosos.gov/biz/BusinessEntityDetail.do?masterFileId=${r.entityid}`,
    }));
  },

  // Federal corporations only; lookup by corporation number ("000100-7") or business number (BN9 or BN15).
  async "cc-api"(form) {
    const digits = form.regNumber.replace(/\D/g, "");
    const key = digits.length >= 9 ? digits.slice(0, 9) : digits.replace(/^0+/, "");
    const d = await getJson(`https://apigateway-passerelledapi.ised-isde.canada.ca/corporations/api/v1/corporations/${key}.json?lang=eng`, {
      headers: { "user-key": process.env.ISED_API_KEY },
    });
    return (d ?? []).filter((c) => c?.corporationNames).map((c) => { // not-found = strings; lang=eng also pads with null
      const names = c.corporationNames.map((n) => n.CorporationName).filter((n) => n.current).map((n) => n.name);
      const a = c.adresses?.[0]?.address;
      return {
        legalName: names[0],
        aliases: names.slice(1),
        ids: [
          { type: "CORP NO", value: c.corporationId },
          c.businessNumbers?.businessNumber && { type: "BN", value: c.businessNumbers.businessNumber },
          // BN15 = BN9 + program account (e.g. RC0001); the registry only knows the BN9 root
          digits.length > 9 && digits.startsWith(c.businessNumbers?.businessNumber) && { type: "BN15", value: form.regNumber },
        ].filter(Boolean),
        status: c.status,
        address: a ? join(a.addressLine, a.city, a.provinceCode, a.postalCode) : "",
        url: `https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=${c.corporationId}`,
      };
    });
  },
  async "orgbook-bc"(form) {
    const d = await getJson(`https://orgbook.gov.bc.ca/api/v4/search/topic?q=${enc(form.regNumber || form.name)}`);
    return (d?.results ?? []).map((r) => {
      const attr = (t) => r.attributes.find((a) => a.type === t)?.value;
      return {
        legalName: r.names.find((n) => n.type === "entity_name")?.text ?? r.names[0]?.text,
        ids: [{ type: "BC REG", value: r.source_id }, attr("business_number") && { type: "BN", value: attr("business_number") }].filter(Boolean),
        status: { ACT: "ACTIVE", HIS: "HISTORICAL" }[attr("entity_status")] ?? attr("entity_status") ?? "",
        address: "",
        url: `https://orgbook.gov.bc.ca/entity/${r.source_id}`,
      };
    });
  },

  async vies(form) {
    const ms = form.country === "GR" ? "EL" : form.country;
    const vat = normId(form.taxId).replace(new RegExp(`^${ms}`), "");
    const d = await getJson(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${ms}/vat/${vat}`);
    if (!d?.isValid) return [];
    // Some member states (DE, ES) confirm the number but withhold the name
    return [{ legalName: d.name === "---" ? null : d.name, ids: [{ type: "VAT", value: `${ms}${vat}` }], status: "VALID", address: d.address === "---" ? "" : d.address.replace(/\n/g, ", "), url: "https://ec.europa.eu/taxation_customs/vies/" }];
  },

  async "fr-sirene"(form) {
    const d = await getJson(`https://recherche-entreprises.api.gouv.fr/search?q=${enc(form.regNumber || form.name)}&per_page=25`);
    return (d?.results ?? []).map((r) => ({
      legalName: r.nom_raison_sociale ?? r.nom_complet,
      ids: [{ type: "SIREN", value: r.siren }],
      status: r.etat_administratif === "A" ? "ACTIVE" : "CLOSED",
      address: r.siege?.adresse ?? "",
      url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${r.siren}`,
    }));
  },

  async "cz-ares"(form) {
    const base = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty";
    const list = form.regNumber
      ? [await getJson(`${base}/${normId(form.regNumber)}`)]
      : (await getJson(`${base}/vyhledat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ obchodniJmeno: form.name, pocet: 25 }) }))?.ekonomickeSubjekty;
    return (list ?? []).filter(Boolean).map((r) => ({
      legalName: r.obchodniJmeno,
      ids: [{ type: "ICO", value: r.ico }, r.dic && { type: "VAT", value: r.dic }].filter(Boolean),
      status: r.datumZaniku ? "CLOSED" : "ACTIVE",
      address: r.sidlo?.textovaAdresa ?? "",
      url: `https://ares.gov.cz/ekonomicke-subjekty?ico=${r.ico}`,
    }));
  },

  async "fi-prh"(form) {
    const q = form.regNumber ? `businessId=${enc(form.regNumber)}` : `name=${enc(form.name)}`;
    const d = await getJson(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?${q}`);
    return (d?.companies ?? []).slice(0, 50).map((c) => {
      const a = c.addresses?.[0];
      return {
        legalName: (c.names.find((n) => n.type === "1" && !n.endDate) ?? c.names[0])?.name,
        ids: [{ type: "Y-tunnus", value: c.businessId.value }],
        // PRH status codes: 2 = registered, 3 = ceased
        status: { 2: "REGISTERED", 3: "CEASED" }[c.status] ?? `status ${c.status}`,
        address: a ? join(a.street, a.postCode, a.postOffices?.[0]?.city) : "",
        url: `https://tietopalvelu.ytj.fi/yritys/${c.businessId.value}`,
      };
    });
  },

  async "ct-sots"(form) {
    // Full-text ($q) on this dataset takes 10 s+; a name prefix up to the first punctuation is instant
    const prefix = form.name.toUpperCase().split(/[,.&()]/)[0].trim().replace(/'/g, "''");
    const where = form.regNumber ? `accountnumber=${enc(`'${form.regNumber.replace(/'/g, "")}'`)}` : `$where=${enc(`starts_with(name, '${prefix}')`)}`;
    const rows = await getJson(`https://data.ct.gov/resource/n7gp-d28j.json?$limit=50&${where}`);
    return (rows ?? []).map((r) => ({
      legalName: r.name,
      ids: [{ type: "CT ID", value: r.accountnumber }],
      status: join(r.status, r.business_type),
      active: r.status ? /^active$/i.test(r.status) : null,
      address: r.billingstreet === "NONE" ? r.mailing_address ?? "" : join(r.billingstreet, r.billingcity, r.billingstate, r.billingpostalcode),
      url: "https://service.ct.gov/business/s/onlinebusinesssearch",
    }));
  },

  async "or-sos"(form) {
    const where = form.regNumber ? `registry_number=${enc(`'${form.regNumber.replace(/'/g, "")}'`)}` : `$q=${enc(form.name)}`;
    const rows = await getJson(`https://data.oregon.gov/resource/tckn-sxa6.json?$limit=50&${where}`);
    // One row per associated name (agent, mailing address...): keep the first per registry number
    const seen = new Set();
    return (rows ?? [])
      .filter((r) => !seen.has(r.registry_number) && seen.add(r.registry_number))
      .map((r) => ({
        legalName: r.business_name,
        ids: [{ type: "OR ID", value: r.registry_number }],
        status: join(r.entity_type, r.registry_date && `registered ${r.registry_date.slice(0, 10)}`),
        active: true, // "Active Businesses" dataset
        address: join(r.address, r.city, r.state, r.zip),
        url: r.business_details?.url ?? "https://sos.oregon.gov/business/pages/find.aspx",
      }));
  },

  async "sg-acra"(form) {
    const base = "https://data.gov.sg/api/action/datastore_search?resource_id=d_3f960c10fed6145404ca7b821f263b87&limit=50";
    const filter = (f) => `&filters=${enc(JSON.stringify(f))}`;
    // Full-text ranking here is loose, so also ask for the exact upper-case name
    const queries = form.regNumber
      ? [filter({ uen: normId(form.regNumber) })]
      : [filter({ entity_name: form.name.toUpperCase().trim() }), `&q=${enc(form.name)}`];
    const pages = await Promise.all(queries.map((q) => getJson(base + q)));
    return pages.flatMap((d) => d?.result?.records ?? []).map((r) => ({
      legalName: r.entity_name,
      ids: [{ type: "UEN", value: r.uen }],
      status: r.uen_status_desc ?? "",
      address: join(r.reg_street_name, r.reg_postal_code),
      url: "https://www.bizfile.gov.sg/",
    }));
  },

  async "ee-rik"(form) {
    const d = await getJson(`https://ariregister.rik.ee/est/api/autocomplete?q=${enc(form.regNumber || form.name)}`);
    return (d?.data ?? []).map((r) => ({
      legalName: r.name,
      aliases: r.historical_names ?? [],
      ids: [{ type: "REG", value: String(r.reg_code) }],
      // R = registered; other RIK codes are left raw and count as unknown, not active
      status: r.status === "R" ? "REGISTERED" : `RIK status ${r.status}`,
      active: r.status === "R" ? true : null,
      address: join(r.legal_address, r.zip_code),
      url: r.url,
    }));
  },

  async "no-brreg"(form) {
    const base = "https://data.brreg.no/enhetsregisteret/api/enheter";
    const list = form.regNumber
      ? [await getJson(`${base}/${normId(form.regNumber)}`)]
      : (await getJson(`${base}?navn=${enc(form.name)}&size=25`))?._embedded?.enheter;
    return (list ?? []).filter(Boolean).map((e) => {
      const a = e.forretningsadresse ?? e.postadresse;
      const dead = e.konkurs || e.underAvvikling || e.underTvangsavviklingEllerTvangsopplosning || e.slettedato;
      return {
        legalName: e.navn,
        ids: [{ type: "ORG NR", value: e.organisasjonsnummer }],
        status: e.slettedato ? "DELETED" : e.konkurs ? "BANKRUPT" : dead ? "BEING WOUND UP" : "REGISTERED",
        active: !dead,
        address: a ? join(a.adresse, a.postnummer, a.poststed) : "",
        url: `https://virksomhet.brreg.no/oppslag/enheter/${e.organisasjonsnummer}`,
      };
    });
  },

  async brasilapi(form) {
    const d = await getJson(`https://brasilapi.com.br/api/cnpj/v1/${normId(form.regNumber)}`);
    if (!d) return [];
    return [{
      legalName: d.razao_social,
      ids: [{ type: "CNPJ", value: d.cnpj }],
      status: d.descricao_situacao_cadastral ?? "",
      address: join(`${d.descricao_tipo_de_logradouro ?? ""} ${d.logradouro ?? ""} ${d.numero ?? ""}`.trim(), d.bairro, d.municipio, d.uf, d.cep),
      url: "https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp",
    }];
  },
};

const TAX_IDS = new Set(["VAT", "EIN", "TRN"]);
// "FR27552032534" and "27552032534" are the same VAT; "0000320193" and "320193" the same CIK
const bareId = (s) => normId(s).replace(/^[A-Z]{2}(?=\d)/, "").replace(/^0+/, "");

// Verified = a record whose name matches and, for each number the form gave, whose ids include it
// when the record carries that kind of id at all (GLEIF holds no VAT number, so a VAT can't fail it).
// A number-only source that withholds the name (legalName null) verifies on the number alone.
export function judge(form, records) {
  const given = [
    [form.regNumber, (t) => !TAX_IDS.has(t) && t !== "LEI"],
    [form.taxId, (t) => TAX_IDS.has(t)],
  ].filter(([v]) => v);
  const idOk = (r) =>
    given.every(([v, kind]) => {
      const own = r.ids.filter((i) => kind(i.type));
      return !own.length || own.some((i) => bareId(i.value) === bareId(v));
    });
  const nameOk = (r) => r.legalName === null || [r.legalName, ...(r.aliases ?? [])].some((n) => normName(n) === normName(form.name));
  // Prefer an active record when a name has both a live and a dissolved entity
  const hits = records.filter((r) => nameOk(r) && idOk(r));
  const hit = hits.find((r) => isActive(r) !== false) ?? hits[0];
  if (!hit) return { outcome: "not_found", verified: false, match: null, candidates: records.slice(0, 5) };
  const note = hit.legalName === null ? "Number valid; this registry does not disclose the name" : undefined;
  if (isActive(hit) === false) return { outcome: "inactive", verified: false, match: hit, note: `Found, but status is ${hit.status}`, candidates: [] };
  return { outcome: "verified", verified: true, match: hit, idMatched: given.some(([v, kind]) => hit.ids.some((i) => kind(i.type) && bareId(i.value) === bareId(v))), note, candidates: [] };
}

// true / false / null (unknown). Adapters set `active` when the source says so structurally;
// otherwise read it from the status text. Negatives first: "INACTIVE" contains "active".
const DEAD = /inactive|dissolv|closed|ceased|cancel|revok|withdr|merged|struck|deregist|expired|historical|bankrupt|liquidat|forfeit|baixada|inapta|nula|suspen|deleted/i;
const LIVE = /active|good standing|registered|ativa|valid|live|existing/i;
export const isActive = (r) => r.active ?? (DEAD.test(r.status ?? "") ? false : LIVE.test(r.status ?? "") ? true : null);

// One line a caller can act on. high = two sources agree, or one agrees on the number too.
export function summarize(results) {
  const auto = results.filter((r) => r.mode === "auto" && !r.supporting); // trademarks prove a brand, not a registered entity
  const trademarksIn = results.filter((r) => r.supporting && r.outcome === "verified").map((r) => r.id);
  const verifiedBy = auto.filter((r) => r.outcome === "verified").map((r) => r.id);
  const inactiveIn = auto.filter((r) => r.outcome === "inactive").map((r) => r.id);
  const status = verifiedBy.length ? "verified" : inactiveIn.length ? "inactive" : "unverified";
  const confidence =
    status !== "verified" ? "none" : verifiedBy.length >= 2 || auto.some((r) => r.outcome === "verified" && r.idMatched) ? "high" : "medium";
  return { status, confidence, verifiedBy, inactiveIn, trademarksIn, manualChecks: results.filter((r) => r.mode === "manual").length };
}

async function verify(form) {
  if (!config.countries[form.country]) throw Object.assign(new Error("unsupported country"), { status: 400 });
  if (String(form.name ?? "").trim().length < 3) throw Object.assign(new Error("name too short"), { status: 400 });
  const results = await Promise.all(
    sourcesFor(form).map(async (s) => {
      const base = { id: s.id, name: s.name, mode: s.mode, ...(s.supporting && { supporting: true }) };
      if (s.mode !== "auto") return { ...base, url: s.url, copy: s.copy };
      if (s.needsEnv?.some((k) => !process.env[k])) return { ...base, skipped: `not configured: set ${s.needsEnv.join(" and ")}` };
      if (s.needs && !form[s.needs]) return { ...base, skipped: `needs ${s.needs === "taxId" ? "a VAT / tax number" : "a registration number"}` };
      try {
        return { ...base, ...judge(form, await auto[s.id](form)) };
      } catch (e) {
        return { ...base, error: e.message };
      }
    }),
  );
  return { country: form.country, checkedAt: new Date().toISOString(), summary: summarize(results), results };
}

// History for the cron recheck. ponytail: one SQLite file; move to Postgres if several servers share it.
let db;
export function store() {
  if (db) return db;
  mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
  db = new DatabaseSync(fileURLToPath(new URL(process.env.DB_FILE ?? "./data/bizverify.db", import.meta.url)));
  db.exec(`CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL, country TEXT, name TEXT,
    status TEXT, confidence TEXT, form TEXT, result TEXT, checked_at TEXT)`);
  db.exec("CREATE INDEX IF NOT EXISTS checks_ref ON checks (ref, id)");
  return db;
}
export function saveCheck(ref, form, result) {
  store()
    .prepare("INSERT INTO checks (ref, country, name, status, confidence, form, result, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ref, form.country, form.name, result.summary.status, result.summary.confidence, JSON.stringify(form), JSON.stringify(result), result.checkedAt);
}
export const history = (ref) =>
  store()
    .prepare("SELECT status, confidence, checked_at, result FROM checks WHERE ref = ? ORDER BY id DESC LIMIT 50")
    .all(ref)
    .map((r) => ({ ...r, result: JSON.parse(r.result) }));

// Only fields the sources use; anything else a client sends is dropped before it is stored.
const FIELDS = ["country", "name", "regNumber", "taxId", "iec", "exporter", "gln", "address", "city", "region", "postalCode", "countryName"];
const pick = (o) => Object.fromEntries(FIELDS.filter((k) => o[k] !== undefined && o[k] !== "").map((k) => [k, typeof o[k] === "string" ? o[k].trim().slice(0, 300) : o[k]]));

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

async function readJson(req) {
  let body = "";
  for await (const chunk of req) if ((body += chunk).length > 1e5) throw Object.assign(new Error("too large"), { status: 413 });
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

const authorized = (req) => {
  const want = process.env.API_KEY;
  const got = req.headers["x-api-key"] ?? "";
  return !!want && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.API_KEY) console.warn("API_KEY not set: /v1 endpoints will refuse every request");
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, page, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/config") return send(res, 200, config);
      if (req.method === "POST" && url.pathname === "/api/verify") return send(res, 200, await verify(pick(await readJson(req))));
      if (url.pathname.startsWith("/v1/")) {
        if (!authorized(req)) return send(res, 401, { error: "missing or wrong x-api-key" });
        // POST /v1/verify {ref?, ...form}: ref groups checks of one company for history and recheck
        if (req.method === "POST" && url.pathname === "/v1/verify") {
          const body = await readJson(req);
          const form = pick(body);
          const result = await verify(form);
          if (body.ref) saveCheck(String(body.ref).slice(0, 100), form, result);
          return send(res, 200, { ref: body.ref ?? null, ...result });
        }
        if (req.method === "GET" && url.pathname === "/v1/checks" && url.searchParams.get("ref"))
          return send(res, 200, { ref: url.searchParams.get("ref"), checks: history(url.searchParams.get("ref")) });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, e.status ?? 500, { error: e.message });
    }
  }).listen(process.env.PORT ?? 3000, () => console.log(`Biz Verify on http://localhost:${process.env.PORT ?? 3000}`));
}

export { verify };
