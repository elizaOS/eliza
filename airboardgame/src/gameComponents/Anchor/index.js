import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Anchor from "./Anchor";
import AnchorFormFields from "./AnchorFormFields";

const AnchorTemplate = createItemTemplate({
  type: "anchor",
  component: Anchor,
  defaultActions: ["clone", "lock", "remove"],
  availableActions: ["clone", "lock", "remove"],
  form: AnchorFormFields,
  name: i18n.t("Anchor"),
  template: {},
  resizeDirections: {},
  excludeFields: { rotation: true, family: true, grid: true },
});

export default AnchorTemplate;
