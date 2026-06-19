add_mlir_dialect_library(MLIRElizaNpuDialect
  IR/ElizaNpuDialect.cpp
  IR/ElizaNpuOps.cpp

  ADDITIONAL_HEADER_DIRS
  ${CMAKE_CURRENT_SOURCE_DIR}/../include/elizanpu

  DEPENDS
  MLIRElizaNpuDialectIncGen
  MLIRElizaNpuOpsIncGen

  LINK_LIBS PUBLIC
  MLIRIR
  MLIRSupport
)

add_mlir_dialect_library(MLIRElizaNpuTransforms
  Transforms/AssignScratch.cpp
  Transforms/LegalizeDescriptorRing.cpp

  ADDITIONAL_HEADER_DIRS
  ${CMAKE_CURRENT_SOURCE_DIR}/../include/elizanpu

  DEPENDS
  MLIRElizaNpuDialectIncGen
  MLIRElizaNpuOpsIncGen
  MLIRElizaNpuPassesIncGen

  LINK_LIBS PUBLIC
  MLIRElizaNpuDialect
  MLIRIR
  MLIRPass
  MLIRTransforms
)
