import { MobileUserProfileByIdPage } from "./client";

export function generateStaticParams() {
  return [{ userId: "_placeholder" }];
}

export default function Page() {
  return <MobileUserProfileByIdPage />;
}
