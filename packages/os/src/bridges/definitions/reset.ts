// spec/os/android/reset.md, "Story: Erase the app's data only after I confirm"; spec/os/android/reset.md, "The renderer hears only that nothing was reset"
import type { ReviewNotice } from "../../../gen/os__android__reset.ts";

export interface DataResetReviewResult {
  readonly notice: ReviewNotice;
  readonly message: string;
}

export interface DataResetPlugin {
  review(): Promise<{ status?: unknown; message?: unknown }>;
}
