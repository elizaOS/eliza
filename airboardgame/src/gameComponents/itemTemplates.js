import AdvancedImageTemplate from "./AdvancedImage";
import AnchorTemplate from "./Anchor";
import CheckerBoardTemplate from "./CheckerBoard";
import CounterTemplate from "./Counter";
import CubeTemplate from "./Cube";
import CylinderTemplate from "./Cylinder";
import DieTemplate from "./Die";
import DieImageTemplate from "./DieImage";
import GeneratorTemplate from "./Generator";
import HexagonTemplate from "./Hexagon";
import ImageTemplate from "./Image";
import JewelTemplate from "./Jewel";
import MeepleTemplate from "./Meeple";
import NoteTemplate from "./Note";
import PawnTemplate from "./Pawn";
import RectTemplate from "./Rect";
import RoundTemplate from "./Round";
import ScreenTemplate from "./Screen";
import TokenTemplate from "./Token";
import ZoneTemplate from "./Zone";

export const itemLibrary = [
  RectTemplate,
  CubeTemplate,
  CylinderTemplate,
  RoundTemplate,
  HexagonTemplate,
  TokenTemplate,
  MeepleTemplate,
  PawnTemplate,
  JewelTemplate,
  CheckerBoardTemplate,
  ImageTemplate,
  AdvancedImageTemplate,
  CounterTemplate,
  DieTemplate,
  DieImageTemplate,
  NoteTemplate,
  AnchorTemplate,
  ZoneTemplate,
  ScreenTemplate,
  GeneratorTemplate,
];

const itemTemplates = Object.fromEntries(
  itemLibrary.map((itemTemplate) => [itemTemplate.type, itemTemplate])
);

export default itemTemplates;
