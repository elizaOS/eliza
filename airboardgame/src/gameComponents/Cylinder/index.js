import i18n from "../../i18n";
import createItemTemplate, { sizeResize } from "../utils";

import Component from "./Cylinder";
import FormComponent from "./CylinderFormFields";

const Template = createItemTemplate({
  type: "cylinder",
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
  name: i18n.t("Cylinder"),
  template: { size: 50, color: "#b3b3b3" },
  resize: sizeResize,
  resizeDirections: { b: true },
});

export default Template;
