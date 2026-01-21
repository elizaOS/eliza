import SmsQrCode from "../components/SmsQrCode";

const ORI_PHONE_NUMBER = process.env.NEXT_PUBLIC_ORI_PHONE_NUMBER ?? "";
const ORI_PHONE_LINK = ORI_PHONE_NUMBER.replace(/[^0-9+]/g, "");

function buildSmsLink(message: string): string {
  if (!ORI_PHONE_LINK) {
    return "";
  }
  if (!message) {
    return `sms:${ORI_PHONE_LINK}`;
  }
  const encodedMessage = encodeURIComponent(message);
  return `sms:${ORI_PHONE_LINK}?&body=${encodedMessage}`;
}

type QrPageProps = {
  searchParams?: Promise<{
    name?: string;
    location?: string;
  }>;
};

export default async function QrPage({ searchParams }: QrPageProps) {
  const params = await searchParams;
  const name = (params?.name ?? "").trim();
  const location = (params?.location ?? "").trim();
  const message =
    name && location
      ? `Hi Ori, I'm ${name} from ${location}, nice to meet you!`
      : "";
  const smsLink = buildSmsLink(message);
  const disabledText = !ORI_PHONE_LINK ? "Phone number not configured" : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-primary)] px-5 py-10 text-[var(--text-primary)]">
      <main className="grid place-items-center">
        <div className="grid min-h-[240px] min-w-[240px] place-items-center rounded-2xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
          <SmsQrCode value={smsLink} disabledText={disabledText} />
        </div>
      </main>
    </div>
  );
}
