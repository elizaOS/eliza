import { data as ass_kisser } from "./ass-kisser";
import { data as degen } from "./degen";
import { data as goody_twoshoes } from "./goody-twoshoes";
import { data as information_trader } from "./information-trader";
import { data as infosec } from "./infosec";
import { data as perps_trader } from "./perps-trader";
import { data as researcher } from "./researcher";
import { data as scammer } from "./scammer";
import { data as social_butterfly } from "./social-butterfly";
import { data as super_predictor } from "./super-predictor";
import { data as trader } from "./trader";

export const templates = [
  ass_kisser,
  degen,
  goody_twoshoes,
  information_trader,
  infosec,
  perps_trader,
  researcher,
  scammer,
  social_butterfly,
  super_predictor,
  trader,
] as const;

export const templateIds = [
  "ass-kisser",
  "degen",
  "goody-twoshoes",
  "information-trader",
  "infosec",
  "perps-trader",
  "researcher",
  "scammer",
  "social-butterfly",
  "super-predictor",
  "trader",
] as const;
