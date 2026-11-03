import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { proPurchaseMessage } from "./billing";

type Step = "age" | "advice" | "intro" | "pair" | "demo" | "done" | "about";

const DEMO = {
  status: "DEMO desk is read-only. No wallet is connected.",
  pnl: "Demo P&L: +0.00 SOL (sample)",
  positions: "No open positions.",
};

export default function App() {
  const [step, setStep] = useState<Step>("age");
  const [back, setBack] = useState<Step>("age");
  const [url, setUrl] = useState("http://127.0.0.1:8787");
  const [note, setNote] = useState("");

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
  page: { flex: 1, backgroundColor: "#050507" },
  wrap: { padding: 24 },
  kicker: { color: "#ffb347", letterSpacing: 3, fontWeight: "700", marginBottom: 12 },
  title: { color: "#f4ecdf", fontSize: 32, fontWeight: "700", marginBottom: 12 },
  body: { color: "#cfc6b6", fontSize: 16, marginBottom: 12 },
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
