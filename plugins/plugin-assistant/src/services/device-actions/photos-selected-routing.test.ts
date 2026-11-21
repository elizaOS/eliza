import { expect, it } from "vitest";
import { deviceActionForCapabilities, proposeDeviceAction } from "./action.ts";
import { PHOTOS_SELECTED_CAPABILITY } from "./photos-view-contract.ts";
import { deviceActionTools } from "./tools.ts";

const VIEW = ["photos.library.v1", "photos.view.v1"];
const forms = (name: string, capabilities: string[]) => {
  const action =
    name === "PROPOSE_DEVICE_ACTION"
      ? proposeDeviceAction
      : deviceActionTools.find((a) => a.name === name);
  if (!action) throw new Error(`Expected ${name}`);
  return (
    deviceActionForCapabilities(action, capabilities)
      .parameters?.find((p) => p.name === "operation")
      ?.schema.anyOf?.filter((branch) =>
        branch.properties?.type?.enum?.some(
          (t: unknown) => t === "photos_share" || t === "photos_album_create",
        ),
      )
      .map((branch) => Boolean(branch.properties?.selected)) ?? []
  );
};

it("offers the open-item Photos form only with photos.view-selected.v1", () => {
  for (const name of [
    "DEVICE_PHOTOS_SHARE",
    "DEVICE_PHOTOS_ALBUM_CREATE",
    "PROPOSE_DEVICE_ACTION",
  ]) {
    expect(forms(name, VIEW)).not.toContain(true);
    expect(forms(name, VIEW)).toContain(false);
    expect(forms(name, [...VIEW, PHOTOS_SELECTED_CAPABILITY])).toContain(true);
    expect(forms(name, [...VIEW, PHOTOS_SELECTED_CAPABILITY])).toContain(false);
  }
});
