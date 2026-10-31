
// Création d'une session de paiement Stripe Checkout.
// Les prix sont recalculés ici, jamais repris du navigateur.

const PRIX = { "100 g": 500, "500 g": 1500, "1 kg": 2500 };
const PORT_RELAIS = 390;
const PORT_DOMICILE = 690;
const FRANCO = 2500;
const POIDS = { "100 g": 0.1, "500 g": 0.5, "1 kg": 1 };

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { erreur: "Méthode non autorisée" });

  // interrupteur : tant que la variable n'est pas sur "oui", rien n'est encaissable
  if ((process.env.VENTES_OUVERTES || "").toLowerCase() !== "oui") {
    return json(503, { erreur: "Les commandes ouvrent très bientôt. Le temps de recevoir les sachets." });
  }

  const cle = process.env.STRIPE_SECRET_KEY;
  if (!cle) return json(500, { erreur: "Clé Stripe absente" });

  let data;
  try { data = JSON.parse(event.body || "{}"); }
  catch { return json(400, { erreur: "Requête illisible" }); }

  const lignes = Array.isArray(data.lignes) ? data.lignes : [];
  const client = data.client || {};
  if (!lignes.length) return json(400, { erreur: "Panier vide" });

  // contrôle des champs client
  for (const champ of ["prenom", "nom", "email", "adresse", "cp", "ville"]) {
    if (!client[champ] || String(client[champ]).trim() === "") {
      return json(400, { erreur: "Champ manquant : " + champ });
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(client.email)) {
    return json(400, { erreur: "Adresse e-mail invalide" });
  }

  // calcul du panier, côté serveur
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("locale", "fr");
  params.set("customer_email", client.email);
  params.set("success_url", "https://lagousse.fr/merci.html?session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", "https://lagousse.fr/commander.html");
  params.set("shipping_address_collection[allowed_countries][0]", "FR");
  params.set("phone_number_collection[enabled]", "true");

  let total = 0,
    index = 0,
    kilos = 0,
    resume = [];

  for (const l of lignes) {
    const label = String(l.label || "");
    const format = Object.keys(PRIX).find((f) => label.includes(f));
    const qte = Math.max(0, Math.min(99, parseInt(l.qte, 10) || 0));
    if (!format || qte === 0) continue;

    const montant = PRIX[format];
    const variete = /canne/i.test(label) ? "canne" : "betterave";
    total += montant * qte;
    kilos += (POIDS[format] || 0) * qte;

    params.set(`line_items[${index}][quantity]`, String(qte));
    params.set(`line_items[${index}][price_data][currency]`, "eur");
    params.set(`line_items[${index}][price_data][unit_amount]`, String(montant));
    params.set(`line_items[${index}][price_data][product_data][name]`,
      `Sucre vanillé ${format} — ${variete}`.replace("- canne", "— canne").replace("- betterave", "— betterave"));
    index++;
    resume.push(`${qte} × ${format} ${variete}`);
  }

  if (index === 0) return json(400, { erreur: "Aucune ligne valide" });

  // port
  const domicile = client.port === "home";
  const montantPort = total >= FRANCO ? 0 : (domicile ? PORT_DOMICILE : PORT_RELAIS);
  params.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  params.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "eur");
  params.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(montantPort));
  params.set("shipping_options[0][shipping_rate_data][display_name]",
    montantPort === 0 ? "Livraison offerte" : (domicile ? "Livraison à domicile" : "Point relais"));

  params.set("metadata[commande]", resume.join(" / ").slice(0, 480));
  params.set("metadata[kg]", String(Math.round(kilos * 1000) / 1000));
  params.set("metadata[nom]", `${client.prenom} ${client.nom}`.slice(0, 480));

  const reponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cle,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const session = await reponse.json();
  if (!reponse.ok) {
    console.error("Stripe:", session);
    return json(502, { erreur: "Paiement indisponible", detail: session.error?.message || "inconnu" });
  }

  return json(200, { url: session.url, id: session.id, total: (total + montantPort) / 100 });
};
