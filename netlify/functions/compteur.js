
// Compteur public : total de kilos réellement payés depuis le début.
// Source de vérité = Stripe. Aucun chiffre inventé, aucun stockage séparé.

const json = (code, body, cache = "no-store") => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": cache },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { erreur: "Méthode non autorisée" });

  const cle = process.env.STRIPE_SECRET_KEY;
  if (!cle) return json(500, { erreur: "Clé Stripe absente" });

  let kilos = 0, commandes = 0, apres = null, pages = 0;

  try {
    do {
      const url = new URL("https://api.stripe.com/v1/checkout/sessions");
      url.searchParams.set("limit", "100");
      if (apres) url.searchParams.set("starting_after", apres);

      const r = await fetch(url, { headers: { Authorization: `Bearer ${cle}` } });
      const d = await r.json();
      if (!r.ok) return json(502, { erreur: "Stripe indisponible" }, "no-store");

      for (const s of d.data || []) {
        if (s.payment_status !== "paid") continue;
        const kg = parseFloat((s.metadata && s.metadata.kg) || "0");
        if (!isFinite(kg) || kg <= 0) continue;
        kilos += kg;
        commandes += 1;
      }
      apres = d.has_more && d.data.length ? d.data[d.data.length - 1].id : null;
      pages += 1;
    } while (apres && pages < 5);
  } catch (e) {
    return json(502, { erreur: "Compteur momentanément indisponible" }, "no-store");
  }

  kilos = Math.round(kilos * 100) / 100;
  // cache court côté CDN : le chiffre reste frais sans taper Stripe à chaque visite
  return json(200, { kg: kilos, commandes }, "public, max-age=120");
};
