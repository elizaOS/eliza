import i18n from "../../i18n";
import createItemTemplate from "../utils";

import CheckerBoard from "./CheckerBoard";
import CheckerBoardFormFields from "./CheckerBoardFormFields";

const CheckerBoardTemplate = createItemTemplate({
  type: "checkerboard",
  component: CheckerBoard,
  defaultActions: ["clone", "lock", "remove"],
  availableActions: ["clone", "lock", "remove"],
  form: CheckerBoardFormFields,
  name: i18n.t("Checkerboard"),
  template: {
    width: 50,
    height: 50,
    color: "#CCC",
    alternateColor: "#888",
    colCount: 3,
    rowCount: 3,
    layer: -1,
  },
});

export default CheckerBoardTemplate;
