import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Component from "./Die";
import FormComponent from "./DieFormFields";

const Template = createItemTemplate({
  type: "dice",
  component: Component,
  form: FormComponent,
  defaultActions: ["roll", "clone", "lock", "remove"],
  availableActions: [
    "roll",
    "clone",
    "lock",
    "remove",
    "alignAsLine",
    "alignAsSquare",
  ],
  name: i18n.t("Die"),
  template: { value: 0, color: "#CCC", textColor: "#fff", fontSize: "35" },
  resizeDirections: {},
});

export default Template;
