import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Component from "./Screen";
import FormComponent from "./ScreenFormFields";

const Template = createItemTemplate({
  type: "screen",
  component: Component,
  form: FormComponent,
  defaultActions: ["clone", "lock", "remove"],
  availableActions: ["clone", "lock", "remove"],
  name: i18n.t("Screen"),
  template: {
    layer: -2,
    width: 200,
    height: 200,
    borderColor: "#cccccc33",
    borderStyle: "solid",
    backgroundColor: "#ccc",
  },
  stateHook: (state, { getCurrentUser }) => {
    const { ownedBy } = state;
    if (!Array.isArray(ownedBy) || !ownedBy.includes(getCurrentUser().uid)) {
      return { ...state, layer: 3.6 };
    }
    return state;
  },
});

export default Template;
