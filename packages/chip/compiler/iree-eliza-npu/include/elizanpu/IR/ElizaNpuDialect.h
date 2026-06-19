//===-- ElizaNpuDialect.h - elizanpu dialect ---------------------*- C++ -*-===//
//
// C++ declarations for the elizanpu MLIR dialect. The actual definitions are
// produced by TableGen from ElizaNpuDialect.td and ElizaNpuOps.td.
//
//===----------------------------------------------------------------------===//

#ifndef ELIZANPU_IR_ELIZANPUDIALECT_H
#define ELIZANPU_IR_ELIZANPUDIALECT_H

#include "mlir/IR/BuiltinTypes.h"
#include "mlir/IR/Dialect.h"
#include "mlir/IR/OpDefinition.h"
#include "mlir/IR/OpImplementation.h"
#include "mlir/Interfaces/InferTypeOpInterface.h"
#include "mlir/Interfaces/SideEffectInterfaces.h"

// Pull in the TableGen-emitted dialect declarations.
#include "elizanpu/IR/ElizaNpuDialect.h.inc"

// Pull in the TableGen-emitted type/attribute declarations.
#define GET_TYPEDEF_CLASSES
#include "elizanpu/IR/ElizaNpuTypes.h.inc"

#define GET_ATTRDEF_CLASSES
#include "elizanpu/IR/ElizaNpuAttrs.h.inc"

// Pull in the TableGen-emitted op declarations.
#define GET_OP_CLASSES
#include "elizanpu/IR/ElizaNpuOps.h.inc"

#endif // ELIZANPU_IR_ELIZANPUDIALECT_H
