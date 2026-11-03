(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ValhallaTrust = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** Public key only. The private key is not in this repo. */
  const PUBLIC_KEY_B64 = "3Y25V3M5MkK354P3Ghw2BnA8locVlep3q86GTOD/EKU=";
  const ADSENSE_CLIENT = "ca-pub-6504655762357230";

  function b64(value) {
    const raw = atob(String(value || ""));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  function offerRow(row) {
    return {
      id: String(row.id),
      partner: String(row.partner),
      title: String(row.title),
      blurb: String(row.blurb),
      url: String(row.url || ""),
      image: String(row.image || ""),
      placements: row.placements || [],
      tier: row.tier,
      category: row.category,
      disclosure: row.disclosure,
    };
  }

  function canonicalOffers(offers) {
    return JSON.stringify((offers || []).map(offerRow));
  }

  function canonicalMonetization(doc) {
    return JSON.stringify({
      adsenseClient: String(doc.adsenseClient || ""),
      admobPublisher: String(doc.admobPublisher || ""),
      admobAppId: String(doc.admobAppId || ""),
      admobBannerAndroid: String(doc.admobBannerAndroid || ""),
      admobBannerIos: String(doc.admobBannerIos || ""),
      admobInterstitialAndroid: String(doc.admobInterstitialAndroid || ""),
      admobRewardedAndroid: String(doc.admobRewardedAndroid || ""),
      admobRewardedIos: String(doc.admobRewardedIos || ""),
      checkoutUrl: String(doc.checkoutUrl || ""),
      checkoutYearlyUrl: String(doc.checkoutYearlyUrl || ""),
      checkoutLifetimeUrl: String(doc.checkoutLifetimeUrl || ""),
      proTradeAllowance: Number(doc.proTradeAllowance),
      trialDays: Number(doc.trialDays),
      offers: (doc.offers || []).map(offerRow),
    });
  }

  function allowanceMessage(doc) {
    return `proTradeAllowance=${Number(doc.proTradeAllowance)}\ntrialDays=${Number(doc.trialDays)}`;
  }

  function counterMessage(doc) {
    return `identity=${doc.identity}\nremaining=${Number(doc.remaining)}\nallowance=${Number(doc.allowance)}`;
  }

  function verify(nacl, message, signatureB64) {
    try {
      const key = b64(PUBLIC_KEY_B64);
      const sig = b64(signatureB64);
      if (key.length !== 32 || sig.length !== 64) return false;
      return nacl.sign.detached.verify(new TextEncoder().encode(String(message)), sig, key);
    } catch {
      return false;
    }
  }

  function verifyMonetization(nacl, doc) {
    if (!doc || !doc.signature) return null;
    if (doc.adsenseClient !== ADSENSE_CLIENT) return null;
    if (!verify(nacl, canonicalMonetization(doc), doc.signature)) return null;
    return doc;
  }

  function verifyOffers(nacl, doc) {
    if (!doc || !Array.isArray(doc.offers) || !doc.signature) return null;
    if (!verify(nacl, canonicalOffers(doc.offers), doc.signature)) return null;
    return doc.offers;
  }

  return {
    PUBLIC_KEY_B64,
    ADSENSE_CLIENT,
    canonicalOffers,
    canonicalMonetization,
    allowanceMessage,
    counterMessage,
    verify,
    verifyMonetization,
    verifyOffers,
  };
});
