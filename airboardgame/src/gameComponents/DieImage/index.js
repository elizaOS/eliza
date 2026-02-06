import i18n from "../../i18n";
import { uid } from "../../utils";
import createItemTemplate from "../utils";

import Component from "./DieImage";
import FormComponent from "./DieImageFormFields";

const defaultDiceImages = () => [
  {
    id: uid(),
    type: "external",
    content: "/game_assets/dice/one.svg",
  },
  {
    id: uid(),
    type: "external",
    content: "/game_assets/dice/two.svg",
  },
  {
    id: uid(),
    type: "external",
    content: "/game_assets/dice/three.svg",
  },
  {
    id: uid(),
    type: "external",
    content: "/game_assets/dice/four.svg",
  },
  {
    id: uid(),
    type: "external",
    content: "/game_assets/dice/five.svg",
  },
  {
    id: uid(),
    type: "external",
    content: "/game_assets/dice/six.svg",
  },
];

const Template = createItemTemplate({
  type: "diceImage",
  component: Component,
  form: FormComponent,
  defaultActions: ["roll", "prevImage", "nextImage", "clone", "lock", "remove"],
  availableActions: [
    "roll",
    "prevImage",
    "nextImage",
    "clone",
    "lock",
    "remove",
    "alignAsLine",
    "alignAsSquare",
  ],
  name: i18n.t("Image die"),
  template: () => ({
    value: 0,
    images: defaultDiceImages(),
    side: 6,
    width: 50,
    height: 50,
  }),
});

export default Template;
