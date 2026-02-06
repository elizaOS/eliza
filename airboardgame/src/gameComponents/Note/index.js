import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Component from "./Note";
import FormComponent from "./NoteFormFields";

const Template = createItemTemplate({
  type: "note",
  component: Component,
  form: FormComponent,
  defaultActions: ["shuffle", "clone", "lock", "remove"],
  availableActions: [
    "shuffle",
    "clone",
    "lock",
    "remove",
    "alignAsLine",
    "alignAsSquare",
  ],
  name: i18n.t("Note"),
  template: {
    color: "#FFEC27",
    textColor: "#000",
    fontSize: 20,
    width: 300,
    height: 200,
  },
});

export default Template;
