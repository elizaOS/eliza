import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Rect from "./Rect";
import RectFormFields from "./RectFormFields";

const RectTemplate = createItemTemplate({
  type: "rect",
  defaultActions: ["lock", "remove"],
  availableActions: [
    "flip",
    "stack",
    "alignAsLine",
    "alignAsSquare",
    "shuffle",
    "clone",
    "lock",
    "remove",
  ],
  component: Rect,
  form: RectFormFields,
  name: i18n.t("Rectangle"),
  template: {
    width: 50,
    height: 50,
    color: "#ccc",
    flippedColor: "#ccc",
    textColor: "#000",
    fontSize: 16,
  },
});

export default RectTemplate;
