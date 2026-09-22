// ============================================================================
// Terminfactory — Telefonassistent (Voice Webhook)
// Anthropic Claude Haiku · Supabase · Twilio (TwiML)
// ============================================================================
//
// Ablauf pro Anruf:
// 1. Anruf kommt rein -> POST /voice -> Begrüßung + <Gather>
// 2. Jede Antwort des Anrufers -> POST /voice/respond -> Claude antwortet
// 3. Vor einer Terminbestätigung prüft der Server live die Verfügbarkeit in
//    Supabase (derselben Tabelle, die auch Online-Buchung & Admin nutzen)
// 4. Bei bestätigtem Termin: Eintrag in `bookings`, "Anfrage eingegangen"-Mail
// 5. Anrufende: Anruf-Dauer, Transkript, Anrufer-Nummer werden dokumentiert

const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.set("trust proxy", true); // damit req.protocol hinter ngrok/Railway korrekt "https" meldet
app.use((req, res, next) => {
  // Erlaubt Aufrufe von der Buchungsseite/dem Dashboard aus (andere Domain).
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const CLAUDE_MODEL = "claude-sonnet-5"; // TEST: stärkeres Modell, um zu prüfen ob Haiku die Genauigkeit verschlechtert hat
const WORKSHOP_ID = process.env.WORKSHOP_ID || "muster";
const WORKSHOP_NAME = process.env.WORKSHOP_NAME || "unserer Werkstatt";

// Öffnungszeiten mit Mittagspause: 08-12 und 13-17 Uhr, in Minuten seit Mitternacht.
const BUSINESS_WINDOWS = [[8 * 60, 12 * 60], [13 * 60, 17 * 60]];
const DEFAULT_DURATION = 30;

// Service -> übliche Dauer in Minuten (gleiche Werte wie auf der Online-Buchungsseite).
const SERVICE_DURATIONS = {
  "Ölwechsel": 30,
  "Reifenwechsel": 30,
  "Großer Kundendienst": 240,
  "Kundendienst": 120,
  "TÜV Vorbereitung": 60,
};

function durationForService(service) {
  if (!service) return DEFAULT_DURATION;
  const s = service.toLowerCase();
  const match = Object.keys(SERVICE_DURATIONS).find((k) => s.includes(k.toLowerCase()));
  return match ? SERVICE_DURATIONS[match] : DEFAULT_DURATION;
}

// Ausnahme: Reifenwechsel (für einen anderen Kunden) darf zeitlich mit einem
// laufenden Großen Kundendienst überlappen — aber NUR wenn die Reifen schon auf
// Felgen sind (schneller Wechsel). Lose Reifen (müssen aufgezogen werden)
// blockieren wie jeder andere Termin.
function canCoexist(candidate, existing) {
  const isReifen = (s) => (s || "").toLowerCase().includes("reifenwechsel") && !(s || "").toLowerCase().includes("kundendienst");
  const isGrosser = (s) => (s || "").toLowerCase().includes("groß") && (s || "").toLowerCase().includes("kundendienst");
  if (isReifen(candidate.service) && isGrosser(existing.service)) {
    return candidate.tire_on_rims === true || candidate.tire_brought === false;
  }
  if (isReifen(existing.service) && isGrosser(candidate.service)) {
    return existing.tire_on_rims === true || existing.tire_brought === false;
  }
  return false;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Timezone-sicher: Wochentag aus Y-M-D berechnen, ohne UTC-Verschiebung.
function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=So, 6=Sa
}

// Belegte Zeitabschnitte, wobei die Mittagspause übersprungen wird:
// reicht die Zeit vor der Pause nicht, geht's danach weiter.
function occupiedIntervals(startMin, duration) {
  let remaining = duration, cur = startMin;
  const segs = [];
  for (const [wStart, wEnd] of BUSINESS_WINDOWS) {
    const s = Math.max(cur, wStart);
    if (s >= wEnd) continue;
    const avail = wEnd - s;
    if (remaining <= avail) { segs.push([s, s + remaining]); return { segs, fits: true }; }
    segs.push([s, wEnd]);
    remaining -= avail;
    cur = wEnd;
  }
  return { segs, fits: false };
}

function intervalsOverlap(a, b) {
  return a.some(([as, ae]) => b.some(([bs, be]) => as < be && bs < ae));
}

// Nimmt tolerant verschiedene Datumsformate entgegen (z.B. volle ISO-Zeitstempel
// von externen Agent-Plattformen wie ThunderPhone) und gibt immer sauberes
// JJJJ-MM-TT zurück, oder null falls gar nichts Sinnvolles erkennbar ist.
function normalizeDate(input) {
  if (!input) return null;
  const str = String(input).trim();
  // Bereits sauber (JJJJ-MM-TT, ggf. mit Zeit/Zeitzone dahinter) — einfach die ersten 10 Zeichen nehmen.
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  // Fallback: irgendein anderes Format, das JS selbst parsen kann.
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(parsed); // JJJJ-MM-TT
}

async function isSlotAvailable(date, timeSlot, service, tireBrought, tireOnRims) {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return false; // Sa/So: für Telefon-Kunden nicht buchbar

  const { data, error } = await supabase
    .from("bookings")
    .select("time_slot, duration_minutes, service, tire_brought, tire_on_rims")
    .eq("workshop_id", WORKSHOP_ID)
    .eq("date", date)
    .in("status", ["pending", "confirmed"]);

  if (error) {
    console.error("Supabase-Fehler bei Verfügbarkeitsprüfung:", error);
    return false;
  }

  const duration = durationForService(service);
  const { segs: candSegs, fits } = occupiedIntervals(toMinutes(timeSlot), duration);
  if (!fits) return false; // passt selbst mit Pausen-Überbrückung nicht mehr in den Tag

  const candidate = { service, tire_brought: tireBrought, tire_on_rims: tireOnRims };
  const conflict = data.some((b) => {
    if (canCoexist(candidate, b)) return false;
    const { segs: bSegs } = occupiedIntervals(toMinutes(b.time_slot), b.duration_minutes || DEFAULT_DURATION);
    return intervalsOverlap(candSegs, bSegs);
  });
  return !conflict;
}

async function insertBooking(booking, callSid) {
  const { error } = await supabase.from("bookings").insert({
    service: booking.service,
    date: booking.date,
    time_slot: booking.time_slot,
    duration_minutes: durationForService(booking.service),
    customer_name: booking.customer_name,
    customer_email: booking.customer_email,
    customer_phone: callerNumbers.get(callSid) || null,
    kfz: booking.kfz,
    workshop_id: WORKSHOP_ID,
    status: "pending",
    source: "phone",
    call_sid: callSid,
    tire_brought: booking.tire_brought ?? null,
    tire_on_rims: booking.tire_on_rims ?? null,
  });
  if (error) {
    console.error("Supabase-Fehler beim Einfügen der Buchung:", error);
    throw error;
  }
  await sendBookingReceivedEmail(booking);
}

// ---- E-Mail (Resend) --------------------------------------------------

// Einheitliches Design für alle E-Mails: dunkler Header mit Logo, weiße Karte darunter.
function emailWrapper(bodyHtml) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#f4f4f4;padding:20px;">
    <div style="background:#1B1D20;border-radius:12px 12px 0 0;padding:20px 24px;">
      <span style="color:#35C078;font-size:20px;">⚡</span>
      <span style="color:#fff;font-size:20px;font-weight:800;vertical-align:middle;">&nbsp;Terminfactory</span>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:24px;border:1px solid #eee;border-top:none;">
      ${bodyHtml}
    </div>
  </div>`;
}

function detailsTable(booking) {
  const row = (label, value) => `<tr><td style="padding:8px 0;color:#888;width:100px;font-size:14px;">${label}</td><td style="padding:8px 0;font-weight:600;color:#1B1D20;font-size:14px;">${value}</td></tr>`;
  return `<table style="width:100%;margin:16px 0;border-collapse:collapse;">
    ${row("Leistung", escapeXml(booking.service || ""))}
    ${row("Datum", booking.date)}
    ${row("Uhrzeit", `${booking.time_slot} Uhr`)}
  </table>`;
}

// Erstellt eine .ics-Kalenderdatei zum Anhängen — Kunde kann sie direkt öffnen,
// der Termin landet automatisch im eigenen Kalender.
function generateICS(booking) {
  const [y, m, d] = booking.date.split("-").map(Number);
  const [h, min] = booking.time_slot.split(":").map(Number);
  const duration = durationForService(booking.service);
  const start = new Date(y, m - 1, d, h, min);
  const end = new Date(start.getTime() + duration * 60000);
  const fmt = (dt) =>
    `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}${String(dt.getMinutes()).padStart(2, "0")}00`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Terminfactory//DE",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@terminfactory`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${booking.service || "Termin"} - ${WORKSHOP_NAME}`,
    `DESCRIPTION:Termin bei ${WORKSHOP_NAME}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

async function sendEmail(to, subject, html, attachments) {
  if (!process.env.RESEND_API_KEY || !to) {
    console.warn("E-Mail nicht verschickt — RESEND_API_KEY fehlt oder keine Empfänger-Adresse vorhanden.");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "termine@terminfactory.de",
        to,
        subject,
        html,
        ...(attachments ? { attachments } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Resend-Fehler (${res.status}) beim Senden an ${to}:`, body);
    }
  } catch (e) {
    console.error("Fehler beim Versenden der E-Mail:", e.message);
  }
}

async function sendBookingReceivedEmail(booking) {
  const body = `
    <div style="color:#E8A33D;font-size:18px;font-weight:700;margin-bottom:6px;">⏳ Anfrage eingegangen</div>
    <p style="color:#555;margin-top:0;">Guten Tag ${escapeXml(booking.customer_name || "")}, vielen Dank für Ihre Terminanfrage bei ${WORKSHOP_NAME}.</p>
    ${detailsTable(booking)}
    <p style="color:#555;">Ihre Anfrage wird von der Werkstatt geprüft. Sie erhalten in Kürze eine Rückmeldung, ob der Termin bestätigt werden kann.</p>`;
  await sendEmail(booking.customer_email, `🟠 Terminanfrage eingegangen — ${WORKSHOP_NAME}`, emailWrapper(body));
}

async function sendBookingDecisionEmail(booking, decision) {
  const isConfirmed = decision === "confirmed";
  const body = isConfirmed
    ? `
    <div style="color:#2FA36B;font-size:18px;font-weight:700;margin-bottom:6px;">✅ Ihr Termin ist bestätigt!</div>
    <p style="color:#555;margin-top:0;">Die Werkstatt hat Ihren Termin bestätigt.</p>
    ${detailsTable(booking)}
    <p style="color:#555;">Im Anhang finden Sie die Kalender-Datei — einfach öffnen und der Termin wird eingetragen.</p>
    <div style="background:#eafaf0;padding:12px 16px;border-radius:8px;color:#2FA36B;font-size:14px;">📎 Termin als .ics Datei im Anhang</div>`
    : `
    <div style="color:#D64545;font-size:18px;font-weight:700;margin-bottom:6px;">❌ Termin nicht bestätigt</div>
    <p style="color:#555;margin-top:0;">Leider konnte Ihr angefragter Termin nicht bestätigt werden.</p>
    ${detailsTable(booking)}
    <p style="color:#555;">Bitte kontaktieren Sie uns für einen alternativen Termin.</p>`;

  let attachments;
  if (isConfirmed) {
    const ics = generateICS(booking);
    attachments = [{ filename: "termin.ics", content: Buffer.from(ics).toString("base64") }];
  }

  await sendEmail(
    booking.customer_email,
    isConfirmed ? `🟢 Ihr Termin ist bestätigt — ${WORKSHOP_NAME}` : `🔴 Ihr Termin konnte leider nicht bestätigt werden — ${WORKSHOP_NAME}`,
    emailWrapper(body),
    attachments
  );
}

// ---- Claude / Gesprächslogik -------------------------------------------

const SYSTEM_PROMPT = `Du bist die Telefon-Rezeption von ${WORKSHOP_NAME}, einem lokalen Handwerksbetrieb (Kfz-Werkstatt).
Melde dich am Anfang des Gesprächs mit dem Namen ${WORKSHOP_NAME} (nicht mit einem erfundenen Namen).
Ein Kunde ruft an, um einen Termin zu buchen. Führe ein kurzes, freundliches,
natürliches Telefongespräch auf Deutsch. Sammle nacheinander:

1) gewünschte Dienstleistung: Ölwechsel, Reifenwechsel, Kundendienst, Großer Kundendienst
   oder TÜV Vorbereitung. Jeweils nur eine Leistung pro Termin.
   FALLS Reifenwechsel gewünscht ist, frag zusätzlich: ob der Kunde eigene Reifen
   mitbringt, und falls ja, ob diese bereits auf Felgen montiert sind oder erst
   noch aufgezogen werden müssen. Weise kurz darauf hin, dass Falschangaben hierzu
   vor Ort zu Verzögerungen oder einer Absage des Termins führen können.
2) gewünschtes Datum (Format: JJJJ-MM-TT) und Uhrzeit (Format: HH:MM). Öffnungszeiten:
   Mo-Fr 08:00-12:00 und 13:00-17:00 Uhr (Mittagspause 12-13 Uhr, in der Zeit keine Termine).
   Samstag und Sonntag sind für Telefonbuchungen NICHT verfügbar — falls danach gefragt
   wird, freundlich auf Mo-Fr verweisen.
3) Name des Kunden
4) Kfz-Kennzeichen
5) E-Mail-Adresse (falls nicht bekannt, freundlich erfragen für die Bestätigung)

Stelle jeweils nur eine Frage pro Antwort, max. 1-2 Sätze (wird vorgelesen,
also kurz und klar, keine Sonderzeichen, keine Listen).

WICHTIG — Gespräch so kurz wie möglich halten (jede Gesprächsrunde kostet echtes Geld),
ABER Genauigkeit geht vor Kürze bei Name/Kennzeichen/E-Mail (siehe unten). Ziel ist es,
mit MAXIMAL 5-6 Fragen ans Ziel zu kommen. Struktur:
1) "Was für einen Service, und wann hätten Sie gerne einen Termin?" (Service + Datum/Uhrzeit zusammen;
   bei Reifenwechsel gleich die Reifen-Frage mit anhängen)
2) "Ihr Vor- und Nachname, bitte?" (NUR der Name — nicht mit dem Kennzeichen zusammen fragen, sonst
   wird oft nur die Hälfte erfasst, weil Kunden nach dem Namen eine kurze Pause machen)
3) "Und das Kfz-Kennzeichen bitte, einzeln buchstabiert und die Zahlen einzeln?" (eigene Frage)
4) "Und Ihre E-Mail-Adresse?" (nur falls für die Bestätigung nötig; falls der Kunde
   zögert oder keine hat, akzeptiere das und mach ohne E-Mail weiter statt nachzuhaken)
5) Zusammenfassung + Bestätigung + [BOOKING_COMPLETE] (siehe Schritte A/B unten)

WICHTIG — Name, Kennzeichen UND E-Mail sind die fehleranfälligsten Angaben am Telefon
(Spracherkennung errät bei Eigennamen, Buchstaben-Zahlen-Kombinationen und "at"/"Punkt"-
Konstruktionen leicht falsch): Wiederhole nach JEDER dieser drei Antworten das Gesagte
noch einmal klar und langsam Buchstabe für Buchstabe zurück, direkt in derselben Antwort,
in der du die nächste Frage stellst (kostet keine zusätzliche Gesprächsrunde), z.B.
"Alles klar, V-S-A-B-1-2-3 notiert — und wie ist Ihre E-Mail-Adresse?" oder bei der
E-Mail "Also l-e-n-n-a-r-t Punkt s-c-h-n-e-b-e-l at gmail Punkt com, richtig?". Wenn
IRGENDETWAS unklar oder mehrdeutig klingt (z.B. Hintergrundgeräusch, undeutliche
Aussprache, ein Wort, das keine echte E-Mail-Domain ergibt), frag lieber einmal gezielt
nach, statt zu raten — eine falsche Buchung ist teurer als eine zusätzliche Frage.

WICHTIG — Verfügbarkeit prüfen:
Sobald du ein konkretes Datum + Uhrzeit hast, darfst du das NICHT direkt bestätigen.
Beende deine Antwort stattdessen exakt mit dem Marker [CHECK_AVAILABILITY] gefolgt von
einem JSON-Objekt: {"date":"JJJJ-MM-TT","time_slot":"HH:MM"} — dieses JSON wird NIE
vorgelesen, nur der Text davor. WICHTIG: Der Text davor wird diesmal WIRKLICH sofort
laut vorgelesen (nicht stillschweigend übersprungen) — sag deshalb IMMER einen kurzen,
natürlichen Satz wie "Alles klar, einen Moment, ich schaue nach." oder "Gut, kurz
prüfen." — nie leer lassen, nie Feldnamen nennen.
Du bekommst danach als Systemantwort mitgeteilt, ob der Slot frei oder belegt ist.
- Wenn frei: fahre normal mit den nächsten Fragen fort.
- Wenn belegt: informiere den Kunden freundlich und frag nach einer Alternative.

WICHTIG — Buchung abschließen (ZWEI GETRENNTE SCHRITTE, NIE ZUSAMMEN):

SCHRITT A — Zusammenfassen und fragen (OHNE Marker):
Sobald alle Infos vorliegen UND der Slot als frei bestätigt wurde, fasse den Termin
in einem normalen Satz zusammen und frag explizit nach ("Passt das so?" o.ä.).
Beende diese Antwort NICHT mit [BOOKING_COMPLETE] — du weißt an dieser Stelle noch
nicht, ob der Kunde zustimmt. Warte auf seine Antwort.

SCHRITT B — Erst NACHDEM der Kunde zugestimmt hat (z.B. "ja", "passt", "genau"):
Bestätige kurz und weise darauf hin, dass die Werkstatt den Termin noch final bestätigen
muss und der Kunde dazu in Kürze eine E-Mail bekommt (z.B. "Wunderbar, ich trage das ein
— Sie bekommen gleich noch eine E-Mail mit der finalen Bestätigung von der Werkstatt.").
Beende JETZT ERST deine
Antwort exakt mit dem Marker [BOOKING_COMPLETE] gefolgt von einem JSON-Objekt mit
den Feldern service, date, time_slot, customer_name, customer_email, kfz — und bei
Reifenwechsel zusätzlich tire_brought (true/false) und, falls true, tire_on_rims
(true/false, sonst null).

Falls der Kunde in Schritt B stattdessen etwas korrigieren will: die Korrektur
übernehmen und wieder bei Schritt A weitermachen (neu zusammenfassen, neu fragen),
NICHT direkt den Marker setzen.

WICHTIG — NIEMALS einen Wochentagsnamen (Montag, Samstag etc.) selbst nennen oder
ausrechnen, weder beim Bestätigen noch in der Zusammenfassung — das führt leicht zu
falschen Angaben. Nenne beim Datum IMMER nur Tag und Monat (z.B. "am 7. September"),
nie den Wochentag. Falls der Kunde selbst einen Wochentag nennt (z.B. "Mittwoch"),
übernimm den nicht ungeprüft in deine eigene Bestätigung — sag stattdessen nur das
Datum zurück.

Das JSON-Objekt nach dem Marker ist NUR für das System bestimmt und wird NIEMALS
vorgelesen — der Teil DAVOR ist das, was der Kunde tatsächlich hört. Sag deshalb
niemals technische Feldnamen wie "service", "date", "time_slot", "customer_name"
laut. Sprich stattdessen ganz natürlich.
Richtig: "Perfekt, dann trage ich den Ölwechsel für Dienstag, den 10. August um 14 Uhr ein."
Falsch: "service Ölwechsel, date 2026-08-10, time_slot 14:00" (NIEMALS so sprechen)

Beispiel für SCHRITT B (Reifenwechsel mit eigenen, bereits montierten Reifen — der
Kunde hat bereits "ja" gesagt):
Wunderbar, ich trage das ein — Sie bekommen gleich noch eine E-Mail mit der finalen Bestätigung von der Werkstatt. [BOOKING_COMPLETE]{"service":"Reifenwechsel","date":"2026-08-10","time_slot":"14:00","customer_name":"Max Mustermann","customer_email":"max@example.com","kfz":"VS-AB123","tire_brought":true,"tire_on_rims":true}`;

const conversations = new Map(); // callSid -> Anthropic-History [{role, content}]
const transcripts = new Map(); // callSid -> Array von {who, text}, lebt bis Anrufende
const callerNumbers = new Map(); // callSid -> anrufende Telefonnummer

function logTranscript(callSid, who, text) {
  if (!callSid || !text) return;
  const arr = transcripts.get(callSid) || [];
  arr.push({ who, text });
  transcripts.set(callSid, arr);
}

function formatTranscript(callSid) {
  const arr = transcripts.get(callSid) || [];
  return arr.map((t) => `${t.who === "caller" ? "Anrufer" : "Assistent"}: ${t.text}`).join("\n");
}

function xmlResponse(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

// Hints verbessern die Trefferquote bei Wörtern, die der Standard-Spracherkennung
// sonst fremd sind — vor allem Kfz-Kennzeichen-Kürzel der Region.
const SPEECH_HINTS = [
  "VS", "OG", "TUT", "RW", "DS", "S", "FR", "KN", "Villingen", "Schwenningen",
  "Ölwechsel", "Reifenwechsel", "Kundendienst", "TÜV", "Kennzeichen",
].join(", ");

function gatherBlock(promptText) {
  return `
    <Gather input="speech" action="/voice/respond" method="POST" speechTimeout="auto" timeout="12" language="de-DE" speechModel="phone_call" enhanced="true" hints="${SPEECH_HINTS}">
      <Say language="de-DE" voice="Polly.Vicki-Generative">${escapeXml(promptText)}</Say>
    </Gather>
    <Say language="de-DE" voice="Polly.Vicki-Generative">Ich habe leider nichts gehört. Auf Wiederhören.</Say>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function callClaude(history) {
  const now = new Date();
  const heute = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const isoHeute = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(now); // JJJJ-MM-TT
  const systemWithDate = `${SYSTEM_PROMPT}\n\nWICHTIG: Heute ist ${heute} (${isoHeute}). Rechne alle relativen
Angaben ("morgen", "Freitag", "nächste Woche" etc.) IMMER ausgehend von diesem echten heutigen Datum.`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 150,
    system: systemWithDate,
    messages: history,
  });
  return response.content?.map((block) => block.text || "").join("") || "";
}

function extractMarker(text, marker) {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const cleanText = text.slice(0, idx).trim();
  const jsonPart = text.slice(idx + marker.length).trim();
  try {
    return { cleanText, data: JSON.parse(jsonPart) };
  } catch (e) {
    // JSON war kaputt/unvollständig — trotzdem NIE den rohen Marker+JSON vorlesen.
    console.error(`Marker ${marker} gefunden, aber JSON ungültig:`, jsonPart);
    return { cleanText, data: null };
  }
}

// Führt eine komplette Runde: ruft Claude auf, löst ggf. CHECK_AVAILABILITY
// automatisch auf (server-seitig, ohne dass der Anrufer etwas davon merkt),
// und gibt am Ende den finalen, sprechbaren Text zurück (+ ggf. Buchung).
async function runTurn(callSid, userText) {
  const history = conversations.get(callSid) || [];
  if (userText) {
    history.push({ role: "user", content: userText });
    logTranscript(callSid, "caller", userText);
  } else if (history.length > 0) {
    // Telnyx/Twilio riefen /voice/respond auf, aber SpeechResult war leer.
    // Ohne diese Zeile würde die Konversation mit einer Assistant-Nachricht enden,
    // was manche Claude-Modelle (z.B. Sonnet) mit einem 400-Fehler ablehnen.
    history.push({ role: "user", content: "(Der Anrufer hat nichts Verständliches gesagt oder war still.)" });
  }

  for (let i = 0; i < 3; i++) {
    const reply = await callClaude(
      history.length ? history : [{ role: "user", content: "Der Anruf beginnt gerade. Melde dich wie am Telefon." }]
    );
    history.push({ role: "assistant", content: reply });

    const availabilityCheck = extractMarker(reply, "[CHECK_AVAILABILITY]");
    if (availabilityCheck) {
      if (!availabilityCheck.data) {
        history.push({
          role: "user",
          content: `SYSTEM: Deine letzte Antwort enthielt kein gültiges JSON nach [CHECK_AVAILABILITY]. Frag Datum und Uhrzeit beim Kunden nochmal kurz und klar nach.`,
        });
        continue;
      }
      // NICHT sofort prüfen — erst die Zwischenansage (cleanText) an den Anrufer
      // zurückgeben, damit keine Stille entsteht, während wir Supabase abfragen.
      // Die eigentliche Prüfung passiert in /voice/continue-check (siehe unten).
      conversations.set(callSid, history);
      logTranscript(callSid, "assistant", availabilityCheck.cleanText);
      return {
        text: availabilityCheck.cleanText || "Einen Moment, ich schaue nach.",
        done: false,
        checkPending: availabilityCheck.data,
      };
    }

    const booking = extractMarker(reply, "[BOOKING_COMPLETE]");
    if (booking) {
      if (!booking.data) {
        history.push({
          role: "user",
          content: `SYSTEM: Deine letzte Antwort enthielt kein gültiges JSON nach [BOOKING_COMPLETE]. Fasse den Termin nochmal zusammen und schließe exakt im vorgegebenen Format ab.`,
        });
        continue;
      }
      const free = await isSlotAvailable(booking.data.date, booking.data.time_slot, booking.data.service, booking.data.tire_brought, booking.data.tire_on_rims);
      if (!free) {
        history.push({
          role: "user",
          content: `SYSTEM: Der Slot ${booking.data.date} ${booking.data.time_slot} wurde inzwischen von jemand anderem gebucht oder passt nicht mehr in die Öffnungszeiten. Informiere den Kunden freundlich und frage nach einer Alternative.`,
        });
        continue;
      }
      await insertBooking(booking.data, callSid);
      conversations.delete(callSid);
      logTranscript(callSid, "assistant", booking.cleanText);
      return { text: booking.cleanText || "Alles eingetragen, vielen Dank!", done: true };
    }

    conversations.set(callSid, history);
    logTranscript(callSid, "assistant", reply.split("[")[0].trim());
    return { text: reply.trim() || "Entschuldigung, könnten Sie das bitte nochmal wiederholen?", done: false };
  }

  conversations.set(callSid, history);
  return { text: "Entschuldigung, könnten Sie das nochmal wiederholen?", done: false };
}

// ---- Routen: Telefon -----------------------------------------------------

function respondForTurn(res, result) {
  const { text, done, checkPending } = result;
  if (checkPending) {
    const redirectUrl = `/voice/continue-check?date=${encodeURIComponent(checkPending.date)}&time_slot=${encodeURIComponent(checkPending.time_slot)}`;
    res.type("text/xml").send(
      xmlResponse(`<Say language="de-DE" voice="Polly.Vicki-Generative">${escapeXml(text)}</Say><Redirect method="POST">${redirectUrl}</Redirect>`)
    );
    return;
  }
  if (done) {
    res.type("text/xml").send(xmlResponse(`<Say language="de-DE" voice="Polly.Vicki-Generative">${escapeXml(text)}</Say><Hangup/>`));
    return;
  }
  res.type("text/xml").send(xmlResponse(gatherBlock(text)));
}

app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  callerNumbers.set(callSid, req.body.From || null);
  try {
    // Aufnahme des kompletten Gesprächs starten (läuft im Hintergrund, blockiert den Anruf nicht).
    // Komplett abgesichert, damit ein fehlender/ungültiger Twilio-Key nie den Anruf selbst kaputt macht.
    if (twilioClient) {
      try {
        const callbackUrl = `${req.protocol}://${req.get("host")}/voice/recording-status`;
        twilioClient
          .calls(callSid)
          .recordings.create({ recordingStatusCallback: callbackUrl, recordingStatusCallbackEvent: ["completed"] })
          .catch((e) => console.error("Aufnahme konnte nicht gestartet werden:", e.message));
      } catch (e) {
        console.error("Aufnahme-Start synchron fehlgeschlagen:", e.message);
      }
    }

    const result = await runTurn(callSid, null);
    const disclosure = `<Say language="de-DE" voice="Polly.Vicki-Generative">Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet.</Say>`;
    // Direkter Sonderfall fürs allererste Turn (Begrüßung) — realistisch nie
    // checkPending/done, aber sauber behandelt statt anzunehmen.
    if (result.checkPending) {
      const redirectUrl = `/voice/continue-check?date=${encodeURIComponent(result.checkPending.date)}&time_slot=${encodeURIComponent(result.checkPending.time_slot)}`;
      res.type("text/xml").send(xmlResponse(disclosure + `<Say language="de-DE" voice="Polly.Vicki-Generative">${escapeXml(result.text)}</Say><Redirect method="POST">${redirectUrl}</Redirect>`));
      return;
    }
    if (result.done) {
      res.type("text/xml").send(xmlResponse(disclosure + `<Say language="de-DE" voice="Polly.Vicki-Generative">${escapeXml(result.text)}</Say><Hangup/>`));
      return;
    }
    res.type("text/xml").send(xmlResponse(disclosure + gatherBlock(result.text)));
  } catch (e) {
    console.error(e);
    res.type("text/xml").send(
      xmlResponse(`<Say language="de-DE">Entschuldigung, es gab ein technisches Problem. Bitte versuchen Sie es später erneut.</Say>`)
    );
  }
});

app.post("/voice/respond", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  try {
    const result = await runTurn(callSid, speechResult);
    respondForTurn(res, result);
  } catch (e) {
    console.error(e);
    res.type("text/xml").send(
      xmlResponse(`<Say language="de-DE">Entschuldigung, es gab ein technisches Problem.</Say><Hangup/>`)
    );
  }
});

app.post("/voice/continue-check", async (req, res) => {
  const callSid = req.body.CallSid;
  const { date, time_slot } = req.query;
  try {
    const history = conversations.get(callSid) || [];
    const serviceGuess = Object.keys(SERVICE_DURATIONS).find((s) =>
      history.some((h) => typeof h.content === "string" && h.content.toLowerCase().includes(s.toLowerCase().split("/")[0].trim()))
    );
    const free = await isSlotAvailable(date, time_slot, serviceGuess);
    const dow = dayOfWeek(date);
    const reason = (dow === 0 || dow === 6)
      ? "GEHT NICHT: dieses Datum ist ein Samstag oder Sonntag, wir haben da keine Telefontermine. Bitte einen Werktag (Mo-Fr) vorschlagen."
      : (free ? "FREI" : "BEREITS BELEGT");
    history.push({
      role: "user",
      content: `SYSTEM: Verfügbarkeitsprüfung für ${date} ${time_slot}: ${reason}. Sprich jetzt ganz normal mit dem Kunden weiter, ohne die Systemantwort wörtlich zu erwähnen.`,
    });
    conversations.set(callSid, history);
    const result = await runTurn(callSid, null);
    respondForTurn(res, result);
  } catch (e) {
    console.error(e);
    res.type("text/xml").send(
      xmlResponse(`<Say language="de-DE">Entschuldigung, es gab ein technisches Problem.</Say><Hangup/>`)
    );
  }
});

app.post("/voice/status", async (req, res) => {
  const { CallStatus, CallDuration, CallSid, From } = req.body;
  if (CallStatus === "completed" && CallDuration) {
    const { error } = await supabase.from("call_logs").insert({
      workshop_id: WORKSHOP_ID,
      call_sid: CallSid,
      duration_seconds: parseInt(CallDuration, 10) || 0,
      transcript: formatTranscript(CallSid),
      caller_number: From || callerNumbers.get(CallSid) || null,
    });
    if (error) console.error("Supabase-Fehler beim Loggen der Anrufdauer:", error);
    transcripts.delete(CallSid);
    callerNumbers.delete(CallSid);
  }
  res.sendStatus(200);
});

app.post("/voice/recording-status", async (req, res) => {
  const { CallSid, RecordingUrl, RecordingStatus } = req.body;
  if (RecordingStatus === "completed" && RecordingUrl) {
    const { error } = await supabase.from("call_logs").update({ recording_url: `${RecordingUrl}.mp3` }).eq("call_sid", CallSid);
    if (error) console.error("Supabase-Fehler beim Speichern der Aufnahme-URL:", error);
  }
  res.sendStatus(200);
});

// ---- Routen: API für Buchungsseite & Dashboard ---------------------------

app.post("/api/booking-received", async (req, res) => {
  try {
    await sendBookingReceivedEmail(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("Fehler bei /api/booking-received:", e.message);
    res.sendStatus(500);
  }
});

// ---- Öffentliche API für externe Agent-Plattformen (z.B. ThunderPhone) ----
// Damit bleibt Supabase die "Single Source of Truth" für alle Kanäle, auch
// wenn das eigentliche Gespräch woanders geführt wird.

app.post("/api/check-availability", async (req, res) => {
  try {
    const { time_slot, service, tire_brought, tire_on_rims } = req.body;
    let { date } = req.body;
    if (!date || !time_slot) {
      res.status(400).json({ error: "date und time_slot sind erforderlich (JJJJ-MM-TT / HH:MM)." });
      return;
    }
    date = normalizeDate(date);
    if (!date) {
      res.status(400).json({ error: "date konnte nicht als gültiges Datum (JJJJ-MM-TT) erkannt werden." });
      return;
    }
    const available = await isSlotAvailable(date, time_slot, service, tire_brought, tire_on_rims);
    res.json({ available });
  } catch (e) {
    console.error("Fehler bei /api/check-availability:", e.message);
    res.status(500).json({ error: "Interner Fehler bei der Verfügbarkeitsprüfung." });
  }
});

app.post("/api/create-booking", async (req, res) => {
  try {
    const { service, time_slot, customer_name, customer_email, customer_phone, kfz, tire_brought, tire_on_rims } = req.body;
    let { date } = req.body;
    if (!service || !date || !time_slot || !customer_name) {
      res.status(400).json({ error: "service, date, time_slot und customer_name sind erforderlich." });
      return;
    }
    date = normalizeDate(date);
    if (!date) {
      res.status(400).json({ error: "date konnte nicht als gültiges Datum (JJJJ-MM-TT) erkannt werden." });
      return;
    }
    const available = await isSlotAvailable(date, time_slot, service, tire_brought, tire_on_rims);
    if (!available) {
      res.status(409).json({ error: "Termin nicht verfügbar (belegt, außerhalb der Öffnungszeiten, oder Sa/So)." });
      return;
    }
    const { error } = await supabase.from("bookings").insert({
      service,
      date,
      time_slot,
      duration_minutes: durationForService(service),
      customer_name,
      customer_email: customer_email || null,
      customer_phone: customer_phone || null,
      kfz: kfz || null,
      workshop_id: WORKSHOP_ID,
      status: "pending",
      source: "phone", // ThunderPhone zählt als Telefon-Kanal
      tire_brought: tire_brought ?? null,
      tire_on_rims: tire_on_rims ?? null,
    });
    if (error) {
      console.error("Supabase-Fehler beim Einfügen der Buchung (API):", error);
      res.status(500).json({ error: "Buchung konnte nicht gespeichert werden." });
      return;
    }
    if (customer_email) {
      await sendBookingReceivedEmail({ customer_name, customer_email, service, date, time_slot });
    }
    res.json({ success: true });
  } catch (e) {
    console.error("Fehler bei /api/create-booking:", e.message);
    res.status(500).json({ error: "Interner Fehler beim Erstellen der Buchung." });
  }
});

app.post("/api/booking-decision", async (req, res) => {
  try {
    const { decision, ...booking } = req.body;
    await sendBookingDecisionEmail(booking, decision);
    res.sendStatus(200);
  } catch (e) {
    console.error("Fehler bei /api/booking-decision:", e.message);
    res.sendStatus(500);
  }
});

// ---- Terminbuchung per E-Mail (Resend Inbound) ---------------------------
// HINWEIS: Diese Route prüft aktuell KEINE Webhook-Signatur von Resend/Svix —
// für den Piloten okay, sollte aber nachgezogen werden, sobald mehr Kunden dranhängen.

async function extractBookingFromEmail(emailText, senderEmail) {
  const prompt = `Ein Kunde hat der Werkstatt ${WORKSHOP_NAME} folgende E-Mail geschrieben, um einen
Termin zu buchen. Extrahiere die Buchungsdaten. Antworte NUR mit einem JSON-Objekt, sonst nichts.

Öffnungszeiten: Mo-Fr 08:00-12:00 und 13:00-17:00 Uhr. Verfügbare Services: Ölwechsel,
Reifenwechsel, Kundendienst, Großer Kundendienst, TÜV Vorbereitung.

Falls ALLE nötigen Angaben da sind (Service, ein konkretes Datum JJJJ-MM-TT, eine konkrete
Uhrzeit HH:MM im Öffnungszeiten-Raster, Name, Kfz-Kennzeichen):
{"complete":true,"service":"...","date":"JJJJ-MM-TT","time_slot":"HH:MM","customer_name":"...","kfz":"...","tire_brought":null,"tire_on_rims":null}

Falls etwas Wichtiges fehlt oder unklar ist:
{"complete":false,"missing":"kurzer, freundlicher Satz auf Deutsch, was noch fehlt oder präzisiert werden muss"}

E-Mail des Kunden (Absender: ${senderEmail}):
"""
${emailText}
"""`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = response.content?.map((b) => b.text || "").join("") || "";
  try {
    return JSON.parse(raw.trim());
  } catch (e) {
    console.error("E-Mail-Buchung: Konnte Antwort nicht als JSON lesen:", raw);
    return { complete: false, missing: "Wir konnten Ihre Anfrage leider nicht eindeutig lesen. Können Sie uns Service, Wunschtermin, Namen und Kennzeichen bitte nochmal in einer Mail zusammenfassen?" };
  }
}

app.post("/email/received", async (req, res) => {
  res.sendStatus(200); // sofort bestätigen, Resend braucht keine Wartezeit
  try {
    const data = req.body?.data || req.body;
    const senderEmail = (data.from || "").match(/<(.+)>/)?.[1] || data.from || "";
    const emailText = data.text || data.html?.replace(/<[^>]+>/g, " ") || "";
    if (!senderEmail || !emailText) return;

    const extracted = await extractBookingFromEmail(emailText, senderEmail);

    if (!extracted.complete) {
      await sendEmail(
        senderEmail,
        `🟠 Noch ein paar Angaben fehlen — ${WORKSHOP_NAME}`,
        emailWrapper(`<div style="color:#E8A33D;font-size:18px;font-weight:700;margin-bottom:6px;">✉️ Noch ein paar Angaben</div>
<p style="color:#555;margin-top:0;">Guten Tag, vielen Dank für Ihre Terminanfrage bei ${WORKSHOP_NAME}.</p>
<p style="color:#555;">${escapeXml(extracted.missing || "Könnten Sie uns bitte Service, Wunschtermin, Namen und Kennzeichen mitteilen?")}</p>`)
      );
      return;
    }

    const free = await isSlotAvailable(extracted.date, extracted.time_slot, extracted.service, extracted.tire_brought, extracted.tire_on_rims);
    if (!free) {
      await sendEmail(
        senderEmail,
        `🔴 Termin leider nicht verfügbar — ${WORKSHOP_NAME}`,
        emailWrapper(`<div style="color:#D64545;font-size:18px;font-weight:700;margin-bottom:6px;">❌ Termin nicht verfügbar</div>
<p style="color:#555;margin-top:0;">Guten Tag ${escapeXml(extracted.customer_name || "")},</p>
${detailsTable(extracted)}
<p style="color:#555;">Dieser Termin ist leider nicht mehr verfügbar oder liegt außerhalb unserer Öffnungszeiten (Mo-Fr). Bitte schlagen Sie uns gerne einen anderen Termin vor.</p>`)
      );
      return;
    }

    const { error } = await supabase.from("bookings").insert({
      service: extracted.service,
      date: extracted.date,
      time_slot: extracted.time_slot,
      duration_minutes: durationForService(extracted.service),
      customer_name: extracted.customer_name,
      customer_email: senderEmail,
      kfz: extracted.kfz,
      workshop_id: WORKSHOP_ID,
      status: "pending",
      source: "email",
      tire_brought: extracted.tire_brought ?? null,
      tire_on_rims: extracted.tire_on_rims ?? null,
    });
    if (error) {
      console.error("Supabase-Fehler beim Einfügen der E-Mail-Buchung:", error);
      return;
    }
    await sendBookingReceivedEmail({ customer_name: extracted.customer_name, customer_email: senderEmail, service: extracted.service, date: extracted.date, time_slot: extracted.time_slot });
  } catch (e) {
    console.error("Fehler bei /email/received:", e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT} (Modell: ${CLAUDE_MODEL}, workshop_id: ${WORKSHOP_ID})`));
