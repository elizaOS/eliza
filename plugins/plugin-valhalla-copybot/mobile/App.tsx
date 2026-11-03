import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import catalog from "../offers.json" with { type: "json" };
import product from "../product.config.json" with { type: "json" };
import { activateLicense, checkoutLink, proPurchaseMessage } from "./billing";

type Offer = {
  id: string;
  partner: string;
  title: string;
  blurb: string;
  url: string;
  placements: string[];
};

function bannerOffers(rows: Offer[]): Offer[] {
  return rows.filter(
    (row) => row.url.startsWith("https://") && row.placements.includes("app-banner")
  );
}

type Step = "age" | "advice" | "intro" | "pair" | "demo" | "done" | "about";

const DEMO = {
  status: "DEMO desk is read-only. No wallet is connected.",
  pnl: "Demo P&L: +0.00 SOL (sample)",
  positions: "No open positions.",
};

export default function App() {
  const [step, setStep] = useState<Step>("age");
  const banner = bannerOffers(catalog.offers as Offer[]);
  const [back, setBack] = useState<Step>("age");
  const [url, setUrl] = useState("http://127.0.0.1:8787");
  const [note, setNote] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseNote, setLicenseNote] = useState("");

  function openAbout() {
    setBack(step);
    setStep("about");
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.wrap}>
        <Text style={styles.kicker}>ACCELERATION</Text>
        {step === "age" && (
          <View>
            <Text style={styles.title}>Are you 18 or older?</Text>
            <Text style={styles.body}>Valhalla is for adults. Crypto can lose money.</Text>
            <Pressable style={styles.btn} onPress={() => setStep("advice")}>
              <Text style={styles.btnText}>I am 18 or older</Text>
            </Pressable>
          </View>
        )}
        {step === "advice" && (
          <View>
            <Text style={styles.title}>Not financial advice</Text>
            <Text style={styles.body}>
              TokenJunction LLC publishes Valhalla. This is not financial advice. The app does not
              promise profit. It cannot send or withdraw. Keys stay on your computer.
            </Text>
            <Pressable style={styles.btn} onPress={() => setStep("intro")}>
              <Text style={styles.btnText}>I understand</Text>
            </Pressable>
          </View>
        )}
        {step === "intro" && (
          <View>
            <Text style={styles.title}>Three short steps</Text>
            <Text style={styles.body}>
              1. Start the desk on your PC. 2. Pair this phone, or try the demo. 3. Read status. No
              wallet yet.
            </Text>
            <Pressable style={styles.btn} onPress={() => setStep("pair")}>
              <Text style={styles.btnText}>Pair the desk</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={() => setStep("demo")}>
              <Text style={styles.btnText}>Try the demo</Text>
            </Pressable>
          </View>
        )}
        {step === "pair" && (
          <View>
            <Text style={styles.title}>Desk address</Text>
            <Text style={styles.body}>
              Phantom and Solflare connect is read-only. The app cannot send or withdraw.
            </Text>
            <Pressable
              style={styles.secondary}
              onPress={() =>
                void Linking.openURL(
                  "https://phantom.app/ul/browse/" + encodeURIComponent(url) + "?ref=valhalla"
                )
              }
            >
              <Text style={styles.btnText}>Connect Phantom</Text>
            </Pressable>
            <Pressable
              style={styles.secondary}
              onPress={() =>
                void Linking.openURL("https://solflare.com/ul/v1/browse/" + encodeURIComponent(url))
              }
            >
              <Text style={styles.btnText}>Connect Solflare</Text>
            </Pressable>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={styles.btn}
              onPress={() => {
                setNote(
                  url.startsWith("http")
                    ? "Address saved on this phone. Open the desk on the PC, then connect."
                    : "Use an address that starts with http."
                );
                setStep("done");
              }}
            >
              <Text style={styles.btnText}>Save and finish</Text>
            </Pressable>
          </View>
        )}
        {step === "demo" && (
          <View>
            <Text style={styles.title}>Demo</Text>
            <Text style={styles.body}>{DEMO.status}</Text>
            <Text style={styles.body}>{DEMO.pnl}</Text>
            <Text style={styles.body}>{DEMO.positions}</Text>
            <Pressable style={styles.btn} onPress={() => setStep("done")}>
              <Text style={styles.btnText}>Leave the demo</Text>
            </Pressable>
          </View>
        )}
        {step === "about" && (
          <View>
            <Text style={styles.title}>About</Text>
            <Text style={styles.body}>
              TokenJunction LLC publishes Valhalla. TokenJunction LLC is a private company. It owns
              Valhalla.
            </Text>
            <Text style={styles.body}>
              This is not financial advice. Crypto can lose money. The phone does not hold a wallet
              key. There is no send or withdraw.
            </Text>
            <Text style={styles.body}>Site: https://valhalla-app.xyz</Text>
            <Text style={styles.body}>Support: hello@valhalla-app.xyz</Text>
            <Text style={styles.body}>© 2026 TokenJunction LLC</Text>
            <Pressable style={styles.btn} onPress={() => setStep(back)}>
              <Text style={styles.btnText}>Back</Text>
            </Pressable>
          </View>
        )}
        {step === "done" && (
          <View>
            <Text style={styles.title}>You are set</Text>
            <Text style={styles.body}>
              {note || "Demo mode used sample data. No wallet was involved."}
            </Text>
            <Text style={styles.body}>What's new: self-repair, Brain advice, and this setup.</Text>
            <Text style={styles.body}>{proPurchaseMessage()}</Text>
            <Text style={styles.body}>
              $9.99/mo launch price. Yearly and Lifetime are coming soon.
            </Text>
            <Pressable style={styles.btn} onPress={() => void Linking.openURL(checkoutLink("ios"))}>
              <Text style={styles.btnText}>Go Pro</Text>
            </Pressable>
            <TextInput
              style={styles.input}
              value={licenseKey}
              onChangeText={setLicenseKey}
              placeholder="License key"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Pressable
              style={styles.secondary}
              onPress={() => {
                void activateLicense(licenseKey).then((message) => {
                  setLicenseKey("");
                  setLicenseNote(message);
                });
              }}
            >
              <Text style={styles.btnText}>Activate Pro</Text>
            </Pressable>
            <Text style={styles.body}>Watchlist</Text>
            <Text style={styles.body}>Free keeps 3 coins. Pro removes the banner.</Text>
            {!licenseNote.includes("Pro is on") ? (
              <View style={styles.ad}>
                {banner.length > 0 && Math.floor(Date.now() / 60000) % 2 === 1 ? (
                  <Pressable
                    onPress={() => {
                      const offer = banner[Math.floor(Date.now() / 86400000) % banner.length];
                      if (!offer) return;
                      const click = String(product.OFFER_CLICK_URL || "");
                      if (click.startsWith("https://") && /^[a-z0-9-]{1,40}$/.test(offer.id)) {
                        void fetch(click, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ id: offer.id, placement: "app-banner" }),
                        }).catch(() => {});
                      }
                      void Linking.openURL(offer.url);
                    }}
                  >
                    <Text style={styles.adLabel}>Affiliate link · we may earn a commission</Text>
                    <Text style={styles.body}>
                      {banner[Math.floor(Date.now() / 86400000) % banner.length]?.title}. Not
                      trading advice.
                    </Text>
                  </Pressable>
                ) : (
                  <>
                    <Text style={styles.adLabel}>Advertisement</Text>
                    <Text style={styles.body}>
                      Advertisement. The AdMob unit comes from the signed monetization file. Until
                      that unit is set, this space stays empty. Not a promise of profit.
                    </Text>
                  </>
                )}
              </View>
            ) : null}
            <Text style={styles.body}>{licenseNote}</Text>
            {!licenseNote.includes("Pro is on") ? (
              <Text style={styles.body}>
                A rewarded ad stays off until its signed unit id is set. It is optional.
              </Text>
            ) : null}
            <Pressable style={styles.secondary} onPress={() => setStep("age")}>
              <Text style={styles.btnText}>Delete this setup</Text>
            </Pressable>
          </View>
        )}
        {step !== "about" && (
          <Pressable style={styles.secondary} onPress={openAbout}>
            <Text style={styles.btnText}>About</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#07080b" },
  wrap: { padding: 24 },
  kicker: { color: "#ffb347", letterSpacing: 3, fontWeight: "700", marginBottom: 12 },
  title: { color: "#ffb347", fontSize: 32, fontWeight: "700", marginBottom: 12, letterSpacing: 1 },
  body: { color: "#cfc6b6", fontSize: 16, marginBottom: 12 },
  ad: {
    minHeight: 50,
    marginTop: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#3a3428",
    padding: 8,
  },
  adLabel: { color: "#93a4ba", fontSize: 11, marginBottom: 4 },
  input: {
    minHeight: 48,
    borderColor: "#2c281f",
    borderWidth: 1,
    color: "#f4ecdf",
    padding: 12,
    marginBottom: 12,
  },
  btn: {
    minHeight: 48,
    backgroundColor: "#ffb347",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  secondary: {
    minHeight: 48,
    borderColor: "#ffb347",
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 10,
  },
  btnText: { color: "#1a1208", fontWeight: "700" },
});
