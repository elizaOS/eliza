import i18n from "../../i18n";
import createItemTemplate from "../utils";

import Component from "./Image";
import FormComponent from "./ImageFormFields";

const Template = createItemTemplate({
  type: "image",
  component: Component,
  form: FormComponent,
  defaultActions: (item) => {
    if (item.backContent) {
      return [
        "flip",
        "flipSelf",
        "tap",
        "stack",
        "shuffle",
        "clone",
        "lock",
        "remove",
      ];
    } else {
      return ["tap", "stack", "shuffle", "clone", "lock", "remove"];
    }
  },
  availableActions: (item) => {
    if (item.backContent) {
      return [
        "flip",
        "flipSelf",
        "tap",
        "rotate",
        "randomlyRotate",
        "stack",
        "alignAsLine",
        "alignAsSquare",
        "shuffle",
        "clone",
        "lock",
        "remove",
      ];
    } else {
      return [
        "tap",
        "rotate",
        "randomlyRotate",
        "stack",
        "alignAsLine",
        "alignAsSquare",
        "shuffle",
        "clone",
        "lock",
        "remove",
      ];
    }
  },
  name: i18n.t("Image"),
  template: {},
  async mapMedia(item, fn) {
    const result = await Promise.all([
      fn(item.content),
      fn(item.backContent),
      fn(item.overlay?.content),
    ]);
    item.content = result[0];
    item.backContent = result[1];
    item.overlay = { content: result[2] };
  },
});

export default Template;
