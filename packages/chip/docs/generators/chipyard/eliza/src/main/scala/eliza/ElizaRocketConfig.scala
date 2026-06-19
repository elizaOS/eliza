package eliza

import org.chipsalliance.cde.config.Config

class WithElizaLinuxBootargs extends Config((site, here, up) => {
  case chipyard.ChosenStdoutPathInDTS => Some("/soc/serial@10001000")
  case chipyard.ChosenBootargsInDTS => Some("earlycon=sbi console=ttySIF0,3686400n8")
})

class ElizaRocketConfig extends Config(
  new eliza.WithElizaLinuxBootargs ++
  new eliza.WithElizaE1Periphery ++
  new chipyard.config.WithUARTInitBaudRate(BigInt(3686400L)) ++
  new chipyard.config.WithUART(address = 0x10001000) ++
  new chipyard.config.WithNoUART ++
  new chipyard.harness.WithBlockDeviceModel ++
  new testchipip.iceblk.WithBlockDevice ++
  new chipyard.config.WithPeripheryTimer ++
  new freechips.rocketchip.rocket.WithNHugeCores(1) ++
  new chipyard.config.AbstractConfig)

class ElizaRocketFastSimConfig extends Config(
  new chipyard.harness.WithSimAXIMem ++
  new eliza.ElizaRocketConfig)
