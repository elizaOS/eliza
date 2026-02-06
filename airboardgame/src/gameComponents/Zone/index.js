import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Component from "./Zone";
import FormComponent from "./ZoneFormFields";

const Template = createItemTemplate({
  type: "zone",
  component: Component,
  form: FormComponent,
  defaultActions: ["clone", "lock", "remove"],
  availableActions: ["clone", "lock", "remove", "alignAsLine", "alignAsSquare"],
  name: i18n.t("Zone"),
  template: {
    layer: -1,
    width: 200,
    height: 200,
    borderColor: "#cccccc33",
    borderStyle: "dotted",
    backgroundColor: "#cccccc00",
    labelPosition: "left",
    insideItems: [],
  },
});

export default Template;
