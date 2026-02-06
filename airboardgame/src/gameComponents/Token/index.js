import i18n from "../../i18n";
import createItemTemplate, { sizeResize } from "../utils";

import Component from "./Token";
import FormComponent from "./TokenFormFields";

const Template = createItemTemplate({
  type: "token",
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
  name: i18n.t("Token"),
  template: {
    size: 50,
    color: "#b3b3b3",
    flippedColor: "#b3b3b3",
    flipped: false,
    textColor: "#000",
    fontSize: 24,
  },
  resize: sizeResize,
  resizeDirections: { b: true },
});

export default Template;
