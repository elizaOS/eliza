import i18n from "../../i18n";
import createItemTemplate, { sizeResize } from "../utils";

import Component from "./Meeple";
import FormComponent from "./MeepleFormFields";

const Template = createItemTemplate({
  type: "meeple",
  component: Component,
  form: FormComponent,
  defaultActions: ["clone", "lock", "remove"],
  availableActions: [
    "stack",
    "alignAsLine",
    "alignAsSquare",
    "shuffle",
    "clone",
    "lock",
    "remove",
  ],
  name: i18n.t("Meeple"),
  template: { size: 50, color: "#b3b3b3" },
  resize: sizeResize,
  resizeDirections: { b: true },
});

export default Template;
