#pragma once
#include <stdio.h>

#include "output_interface.h"

// provides an interface for writing to a file object

void file_output_new(OutputInterface* output, FILE* file);
