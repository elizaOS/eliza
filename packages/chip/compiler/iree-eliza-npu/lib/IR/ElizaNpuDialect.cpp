//===-- ElizaNpuDialect.cpp - elizanpu dialect registration --------------===//
//
// Registers the elizanpu dialect, types, and attributes. Op verifiers live in
// ElizaNpuOps.cpp.
//
//===----------------------------------------------------------------------===//

#include "elizanpu/IR/ElizaNpuDialect.h"

#include "mlir/IR/Builders.h"
#include "mlir/IR/DialectImplementation.h"

using namespace mlir;
using namespace mlir::elizanpu;

#include "elizanpu/IR/ElizaNpuDialect.cpp.inc"

void ElizaNpuDialect::initialize() {
  addTypes<
#define GET_TYPEDEF_LIST
#include "elizanpu/IR/ElizaNpuTypes.cpp.inc"
      >();
  addAttributes<
#define GET_ATTRDEF_LIST
#include "elizanpu/IR/ElizaNpuAttrs.cpp.inc"
      >();
  addOperations<
#define GET_OP_LIST
#include "elizanpu/IR/ElizaNpuOps.cpp.inc"
      >();
}

#define GET_TYPEDEF_CLASSES
#include "elizanpu/IR/ElizaNpuTypes.cpp.inc"

#define GET_ATTRDEF_CLASSES
#include "elizanpu/IR/ElizaNpuAttrs.cpp.inc"
