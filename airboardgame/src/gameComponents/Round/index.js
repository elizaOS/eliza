import i18n from "../../i18n";
import createItemTemplate, { radiusResize } from "../utils";

import Component from "./Round";
import FormComponent from "./RoundFormFields";

const Template = createItemTemplate({
  type: "round",
  component: Component,
  form: FormComponent,
  defaultActions: ["clone", "lock", "remove"],
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
  name: i18n.t("Round"),
  template: {
    radius: 50,
    color: "#ccc",
    flippedColor: "#ccc",
    flipped: false,
    textColor: "#000",
    fontSize: 16,
  },
  resize: radiusResize,
  resizeDirections: { b: true },
});

export default Template;
