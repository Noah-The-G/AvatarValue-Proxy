// index.js - Rolimons proxy (wide-scan: limiteds + accessories + JSON blobs)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const cache = {};

// Helper: normalize number tokens like "25,000" -> 25000
function parseNumberToken(token) {
  if (!token || typeof token !== "string") return null;
  const cleaned = token.replace(/[^\d,.\s\u00A0]/g, "").trim();
  if (!cleaned) return null;
  let tmp = cleaned.replace(/\u00A0/g, "").replace(/\s+/g, "");
  tmp = tmp.replace(/,/g, "");
  if ((tmp.match(/\./g) || []).length > 1) tmp = tmp.replace(/\./g, "");
  const digits = tmp.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// Scan HTML root for price elements using a list of selectors
function scanHtmlForPrices($, root, selectors) {
  const items = [];
  if (!root || !root.length) return items;
  for (const sel of selectors) {
    root.find(sel).each((i, el) => {
      try {
        const txt = $(el).text() || "";
        const n = parseNumberToken(txt);
        if (n !== null) {
          // try to get an item name nearby
          let name = "";
          const parent = $(el).closest(".card, .item-card, li, tr, .inventory-item, .media, .d-flex");
          if (parent && parent.length) {
            name = parent.find(".item-name, .name, strong, .text-truncate").first().text().trim() || "";
          }
          if (!name) {
            name = ($(el).prev().text() || "").trim() || ($(el).parent().text() || "").trim().slice(0,80);
          }
          items.push({ source: "html", selector: sel, snippet: name.slice(0,140), value: n });
        }
      } catch (e) {}
    });
  }
  return items;
}

// recursive JSON search for numeric price fields
function searchJsonForPrices(obj, ctx) {
  const out = [];
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    for (const it of obj) out.push(...searchJsonForPrices(it, ctx));
    return out;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      try {
        const v = obj[k];
        if (/price|value|robux|cost/i.test(k)) {
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
            out.push({ source: "json", ctx, key: k, snippet: (obj.name || obj.title || obj.Name || "").toString().slice(0,140), value: Math.round(v) });
          } else if (typeof v === "string") {
            const n = parseNumberToken(v);
            if (n !== null) out.push({ source: "json", ctx, key: k, snippet: (obj.name || obj.title || "").toString().slice(0,140), value: n });
          } else if (typeof v === "object") {
            out.push(...searchJsonForPrices(v, ctx));
          }
        } else {
          if (typeof v === "object") out.push(...searchJsonForPrices(v, ctx));
          else if (typeof v === "string") {
            if (v.match(/[\d][\d,.\s\u00A0]{1,}/)) {
              const n = parseNumberToken(v);
              if (n !== null && n > 0) out.push({ source: "json", ctx, key: k, snippet: (obj.name || "").toString().slice(0,140), value: n });
            }
          }
        }
      } catch (e) {}
    }
  }
  return out;
}

// Scan JSON-like script blobs for numeric price fields
function scanJsonBlobsForPrices($) {
  const items = [];

  try {
    const nd = $("#__NEXT_DATA__");
    if (nd && nd.length) {
      const j = JSON.parse(nd.text());
      items.push(...searchJsonForPrices(j, "next_data"));
    }
  } catch (e) {}

  $("script[type='application/ld+json']").each((i, el) => {
    try {
      const j = JSON.parse($(el).text());
      items.push(...searchJsonForPrices(j, "ld_json"));
    } catch (e) {}
  });

  $("script").each((i, el) => {
    try {
      const txt = $(el).html() || "";
      if (txt.length > 60 && /price|priceInRobux|value|inventory|items|limited/i.test(txt)) {
        const m = txt.match(/(\{[\s\S]*\})/m);
        if (m && m[1]) {
          try {
            const j = JSON.parse(m[1]);
            items.push(...searchJsonForPrices(j, "inline_json"));
          } catch (e) {}
        } else {
          const ma = txt.match(/(\[[\s\S]*\])/m);
          if (ma && ma[1]) {
            try {
              const arr = JSON.parse(ma[1]);
              items.push(...searchJsonForPrices(arr, "inline_json_array"));
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  });

  return items;
}

// dedupe items by snippet + value
function dedupeItems(items) {
  const map = new Map();
  for (const it of items) {
    const key = (it.snippet || "").replace(/\s+/g, " ").slice(0,80) + "::" + (it.value || 0);
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

// fetch page
async function fetchPlayerPage(userId) {
  const url = `https://www.rolimons.com/player/${userId}`;
  const resp = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "AvatarValueProxy/scan-wide" }, validateStatus: null });
  return { status: resp.status, url, html: resp.data, headers: resp.headers };
}

// routes
app.get("/clearCache", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  const key = `u:${userId}`;
  delete cache[key];
  return res.json({ ok: true, cleared: key });
});

app.get("/avatarValue", async (req, res) => {
  const userId = req.query.userId;
  const nocache = req.query.nocache === "1" || req.query.nocache === "true";
  const debug = req.query.debug === "1" || req.query.debug === "true";

  if (!userId) return res.status(400).json({ error: "Missing userId" });
  const cacheKey = `u:${userId}`;
  const cached = cache[cacheKey];
  if (!nocache && cached && Date.now() - cached.ts < CACHE_TTL) {
    const out = { totalValue: cached.value, source: cached.source || "cache" };
    if (debug && cached.debug) out.debug = cached.debug;
    return res.json(out);
  }

  // fetch page
  let page;
  try {
    page = await fetchPlayerPage(userId);
    if (!page || page.status !== 200) {
      return res.status(502).json({ error: "Failed to fetch Rolimons page", status: page ? page.status : null });
    }
  } catch (err) {
    return res.status(502).json({ error: "Fetch failed", reason: err.message });
  }

  const $ = cheerio.load(page.html || "");
  const htmlSelectors = [
    "span.text-light.text-truncate",
    ".text-muted.text-truncate",
    ".value",
    ".price",
    ".item-price",
    ".limited-price",
    ".inventory-price",
    "td.price",
    "span.price",
    ".text-right .text-truncate"
  ];

  // scan sections (inventory limited + ugc limited) first
  const sectionSelectors = ["#inventoryugclimiteds", "#inventorylimiteds", "div[id*='inventory']", "div[id*='limited']"];
  let itemsFound = [];

  for (const sec of sectionSelectors) {
    const root = $(sec);
    if (root && root.length) {
      const htmlItems = scanHtmlForPrices($, root, htmlSelectors);
      if (htmlItems && htmlItems.length) itemsFound.push(...htmlItems);
    }
  }

  // if none in sections, scan document for these selectors (includes regular accessories)
  if (itemsFound.length === 0) {
    itemsFound.push(...scanHtmlForPrices($, $.root(), htmlSelectors));
  }

  // also parse JSON blobs for prices
  const jsonItems = scanJsonBlobsForPrices($);
  if (jsonItems && jsonItems.length) itemsFound.push(...jsonItems);

  // dedupe and sum
  const deduped = dedupeItems(itemsFound);
  let total = deduped.reduce((acc, it) => acc + (it.value || 0), 0);

  // last-resort fallback
  if (total === 0) {
    const bodyText = $("body").text() || "";
    const toks = (bodyText.match(/[\d][\d,.\s\u00A0]{1,}/g) || []).map(parseNumberToken).filter(Boolean);
    if (toks.length) {
      toks.sort((a,b)=>b-a);
      total = toks[0] || 0;
    }
  }

  const debugObj = { method: "scan-wide", count: deduped.length, items: deduped.slice(0,40) };
  cache[cacheKey] = { value: total, ts: Date.now(), source: page.url, debug: debugObj };

  const out = { totalValue: total, source: page.url };
  if (debug) out.debug = debugObj;
  return res.json(out);
});

app.get("/", (req, res) => res.json({ ok: true, msg: "rolimons-proxy wide-scan alive" }));

app.listen(PORT, () => console.log(`rolimons-proxy wide-scan listening on port ${PORT}`));
