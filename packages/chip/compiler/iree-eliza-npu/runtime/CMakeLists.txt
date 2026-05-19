add_library(eliza_npu_runtime STATIC
  eliza_npu_runtime.c
)
target_include_directories(eliza_npu_runtime
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}
)
set_target_properties(eliza_npu_runtime PROPERTIES POSITION_INDEPENDENT_CODE ON)
