import i18n from "../../i18n";
import createItemTemplate from "../utils";

import AdvancedImage from "./AdvancedImage";
import AdvancedImageFormFields from "./AdvancedImageFormFields";

const RectTemplate = createItemTemplate({
  type: "advancedImage",
  component: AdvancedImage,
  defaultActions: (item) => {
    let actions = ["stack", "shuffle", "clone", "lock", "remove"];
    if (item.layers?.length) {
      actions = ["nextImage"].concat(actions);
    }
    if (item.back) {
      return ["flip", "flipSelf"].concat(actions);
    } else {
      return actions;
    }
  },
  availableActions: (item) => {
    let actions = [
      "tap",
      "rotate",
      "randomlyRotate",
      "stack",
      "alignAsLine",
      "alignAsSquare",
      "shuffle",
      "clone",
      "lock",
      "remove",
    ];
    if (item.layers?.length) {
      actions = ["prevImageForLayer", "nextImageForLayer", "rollLayer"].concat(
        actions
      );
    }
    if (item.back) {
      return ["flip", "flipSelf"].concat(actions);
    } else {
      return actions;
    }
  },
  form: AdvancedImageFormFields,
  name: i18n.t("Advanced Image"),
  template: { layers: [], front: "/default.png" },
});

export default RectTemplate;
