import i18n from "../../i18n";
import createItemTemplate, { sizeResize } from "../utils";

import Component from "./Hexagon";
import FormComponent from "./HexagonFormFields";

const Template = createItemTemplate({
  type: "hexagon",
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
  name: i18n.t("Hexagon"),
  template: {
    size: 50,
    color: "#ccc",
    flippedColor: "#ccc",
    textColor: "#000",
    fontSize: "16",
  },
  resize: sizeResize,
  resizeDirections: { b: true },
});

export default Template;
