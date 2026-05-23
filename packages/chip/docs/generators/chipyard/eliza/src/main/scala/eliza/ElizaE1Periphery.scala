package eliza

import chisel3._
import chisel3.util._
import freechips.rocketchip.diplomacy._
import freechips.rocketchip.prci._
import freechips.rocketchip.regmapper.{RegField, RegWriteFn}
import freechips.rocketchip.subsystem.{BaseSubsystem, PBUS}
import freechips.rocketchip.tilelink._
import org.chipsalliance.cde.config.{Config, Field, Parameters}

case class ElizaE1PeripheryParams(
  dmaAddress: BigInt = 0x10010000L,
  npuAddress: BigInt = 0x10020000L,
  displayAddress: BigInt = 0x10030000L)

case object ElizaE1PeripheryKey extends Field[Option[ElizaE1PeripheryParams]](None)

class ElizaE1NPU(address: BigInt, beatBytes: Int)(implicit p: Parameters)
    extends ClockSinkDomain(ClockSinkParameters())(p) {
  private val device = new SimpleDevice("npu", Seq("eliza,e1-npu"))
  val node = TLRegisterNode(Seq(AddressSet(address, 0xfff)), device, "reg/control", beatBytes = beatBytes)

  override lazy val module = new Impl {
    withClockAndReset(clock, reset) {
    val opA = RegInit(0.U(32.W))
    val opB = RegInit(0.U(32.W))
    val result = RegInit(0.U(32.W))
    val ctrlStatus = RegInit(2.U(32.W))
    val opcode = RegInit(0.U(32.W))
    val acc = RegInit(0.U(32.W))
    val resultHi = RegInit(0.U(32.W))
    val trace = RegInit(0.U(32.W))
    val gemmCfg = RegInit(0.U(32.W))
    val gemmBase = RegInit(0.U(32.W))
    val gemmStride = RegInit(0.U(32.W))
    val unsupportedOps = RegInit(0.U(32.W))
    val cmdParam = RegInit(0.U(32.W))
    val descBase = RegInit(0.U(32.W))
    val descHead = RegInit(0.U(32.W))
    val descTail = RegInit(0.U(32.W))
    val descStatus = RegInit(0.U(32.W))
    val perfCycles = RegInit(0.U(32.W))
    val perfMacs = RegInit(0.U(32.W))
    val perfOps = RegInit(0.U(32.W))
    val perfErrors = RegInit(0.U(32.W))
    val descTimeoutCount = RegInit(0.U(32.W))
    val descBytesRead = RegInit(0.U(32.W))
    val descBytesWritten = RegInit(0.U(32.W))
    val descReadBeats = RegInit(0.U(32.W))
    val descWriteBeats = RegInit(0.U(32.W))
    val stallCycles = RegInit(0.U(32.W))
    val scratchBytes = RegInit(64.U(32.W))
    val thermalThrottle = RegInit(0.U(32.W))
    val scratch = RegInit(VecInit(Seq.fill(16)(0.U(32.W))))

    def byteAt(index: UInt): UInt = {
      val word = scratch(index(5, 2))
      (word >> (index(1, 0) << 3))(7, 0)
    }

    def s8At(index: UInt): SInt = byteAt(index).asSInt

    def relu4(value: UInt): UInt = {
      val out = Wire(Vec(4, UInt(8.W)))
      for (i <- 0 until 4) {
        val lane = value(8 * i + 7, 8 * i).asSInt
        out(i) := Mux(lane < 0.S, 0.U, lane.asUInt)
      }
      out.asUInt
    }

    def gemmCell(row: Int, col: Int, m: UInt, n: UInt, k: UInt, bBase: UInt): SInt = {
      val terms = (0 until 7).map { kk =>
        val active = row.U < m && col.U < n && kk.U < k
        val a = s8At(row.U * k + kk.U)
        val b = s8At(bBase + kk.U * n + col.U)
        Mux(active, a * b, 0.S(32.W))
      }
      terms.reduce(_ +& _).asSInt
    }

    def runGemm(): Unit = {
      val m = gemmCfg(7, 0)
      val n = gemmCfg(15, 8)
      val k = gemmCfg(23, 16)
      val bBase = gemmBase(15, 8)
      val cBase = gemmBase(23, 16)
      val cWordBase = cBase(7, 2)
      val cells = Seq(
        gemmCell(0, 0, m, n, k, bBase),
        gemmCell(0, 1, m, n, k, bBase),
        gemmCell(0, 2, m, n, k, bBase),
        gemmCell(1, 0, m, n, k, bBase),
        gemmCell(1, 1, m, n, k, bBase),
        gemmCell(1, 2, m, n, k, bBase),
        gemmCell(2, 0, m, n, k, bBase),
        gemmCell(2, 1, m, n, k, bBase),
        gemmCell(2, 2, m, n, k, bBase))

      for (i <- cells.indices) {
        val wordIndex = cWordBase + i.U
        when(i.U < (m * n)) {
          for (w <- 0 until 16) {
            when(wordIndex === w.U) {
              scratch(w) := cells(i).asUInt
            }
          }
        }
      }
      perfCycles := 12.U
      perfMacs := m * n * k
      perfOps := perfOps + 1.U
      perfErrors := 0.U
      unsupportedOps := 0.U
      result := cells.head.asUInt
      resultHi := cells(1).asUInt
    }

    def runOpcode(): Unit = {
      when(opcode === 8.U) {
        runGemm()
      }.elsewhen(opcode === 10.U) {
        result := relu4(opA)
        perfCycles := 1.U
        perfOps := perfOps + 1.U
        perfErrors := 0.U
        unsupportedOps := 0.U
      }.otherwise {
        result := opA + opB + acc
        unsupportedOps := unsupportedOps + 1.U
      }
      ctrlStatus := 2.U
      trace := trace + 1.U
    }

    val ctrlWrite = RegWriteFn { (valid: Bool, data: UInt) =>
      when(valid) {
        when(data(2)) { perfErrors := 0.U }
        when(data(1)) { ctrlStatus := ctrlStatus & ~2.U(32.W) }
        when(data(0)) { runOpcode() }
      }
      true.B
    }

    val scratchFields = (0 until 16).map { i =>
      (0x80 + i * 4) -> Seq(RegField(32, scratch(i)))
    }

    node.regmap((Seq(
      0x00 -> Seq(RegField(32, opA)),
      0x04 -> Seq(RegField(32, opB)),
      0x08 -> Seq(RegField.r(32, result)),
      0x0c -> Seq(RegField(32, ctrlStatus, ctrlWrite)),
      0x10 -> Seq(RegField(32, opcode)),
      0x14 -> Seq(RegField(32, acc)),
      0x18 -> Seq(RegField.r(32, resultHi)),
      0x1c -> Seq(RegField.r(32, trace)),
      0x20 -> Seq(RegField(32, gemmCfg)),
      0x24 -> Seq(RegField(32, gemmBase)),
      0x28 -> Seq(RegField(32, gemmStride)),
      0x2c -> Seq(RegField.r(32, unsupportedOps)),
      0x30 -> Seq(RegField(32, cmdParam)),
      0x40 -> Seq(RegField(32, descBase)),
      0x44 -> Seq(RegField(32, descHead)),
      0x48 -> Seq(RegField(32, descTail)),
      0x4c -> Seq(RegField.r(32, descStatus)),
      0x50 -> Seq(RegField.r(32, perfCycles)),
      0x54 -> Seq(RegField.r(32, perfMacs)),
      0x58 -> Seq(RegField.r(32, perfOps)),
      0x5c -> Seq(RegField.r(32, perfErrors)),
      0x60 -> Seq(RegField.r(32, descTimeoutCount)),
      0x64 -> Seq(RegField.r(32, descBytesRead)),
      0x68 -> Seq(RegField.r(32, descBytesWritten)),
      0x6c -> Seq(RegField.r(32, descReadBeats)),
      0x70 -> Seq(RegField.r(32, descWriteBeats)),
      0x74 -> Seq(RegField.r(32, stallCycles)),
      0x78 -> Seq(RegField.r(32, scratchBytes)),
      0x7c -> Seq(RegField.r(32, thermalThrottle))) ++ scratchFields): _*)
    }
  }
}

class ElizaE1DMA(address: BigInt, beatBytes: Int)(implicit p: Parameters)
    extends ClockSinkDomain(ClockSinkParameters())(p) {
  private val device = new SimpleDevice("dma", Seq("eliza,e1-dma"))
  val node = TLRegisterNode(Seq(AddressSet(address, 0xfff)), device, "reg/control", beatBytes = beatBytes)

  override lazy val module = new Impl {
    withClockAndReset(clock, reset) {
      val regs = RegInit(VecInit(Seq.fill(15)(0.U(32.W))))
      node.regmap((0 until 15).map(i => (i * 4) -> Seq(RegField(32, regs(i)))): _*)
    }
  }
}

class ElizaE1Display(address: BigInt, beatBytes: Int)(implicit p: Parameters)
    extends ClockSinkDomain(ClockSinkParameters())(p) {
  private val device = new SimpleDevice("display", Seq("eliza,e1-display"))
  val node = TLRegisterNode(Seq(AddressSet(address, 0xfff)), device, "reg/control", beatBytes = beatBytes)

  override lazy val module = new Impl {
    withClockAndReset(clock, reset) {
      val regs = RegInit(VecInit(Seq.fill(10)(0.U(32.W))))
      node.regmap((0 until 10).map(i => (i * 4) -> Seq(RegField(32, regs(i)))): _*)
    }
  }
}

trait CanHavePeripheryElizaE1 { this: BaseSubsystem =>
  private val pbus = locateTLBusWrapper(PBUS)

  p(ElizaE1PeripheryKey).foreach { params =>
    val dma = LazyModule(new ElizaE1DMA(params.dmaAddress, pbus.beatBytes)(p))
    val npu = LazyModule(new ElizaE1NPU(params.npuAddress, pbus.beatBytes)(p))
    val display = LazyModule(new ElizaE1Display(params.displayAddress, pbus.beatBytes)(p))

    dma.clockNode := pbus.fixedClockNode
    npu.clockNode := pbus.fixedClockNode
    display.clockNode := pbus.fixedClockNode

    pbus.coupleTo("eliza-e1-dma") { dma.node := TLFragmenter(pbus.beatBytes, pbus.blockBytes) := _ }
    pbus.coupleTo("eliza-e1-npu") { npu.node := TLFragmenter(pbus.beatBytes, pbus.blockBytes) := _ }
    pbus.coupleTo("eliza-e1-display") { display.node := TLFragmenter(pbus.beatBytes, pbus.blockBytes) := _ }
  }
}

class WithElizaE1Periphery extends Config((_, _, _) => {
  case ElizaE1PeripheryKey => Some(ElizaE1PeripheryParams())
})
