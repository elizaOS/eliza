import i18n from "../../i18n";
import createItemTemplate, { sizeResize } from "../utils";

import Component from "./Cube";
import FormComponent from "./CubeFormFields";

const Template = createItemTemplate({
  type: "cube",
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
  name: i18n.t("Cube"),
  template: { size: 50, color: "#b3b3b3" },
  resize: sizeResize,
  resizeDirections: { b: true },
});

export default Template;
