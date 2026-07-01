import { PeprModule } from "pepr";
import { ServerController } from "./capabilities/index";
import cfg from "./package.json";

new PeprModule(cfg, [ServerController]);
