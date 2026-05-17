#ifndef FEAL_H
#define FEAL_H

#include <stdint.h>

// Initialize the key array with random values
void create_random_keys(void);

// FEAL encryption function
// Takes a 64-bit plaintext and returns 64-bit ciphertext
uint64_t encrypt(uint64_t plaintext);

// Get the current keys
// Returns a pointer to the key array (6 uint32_t values)
uint32_t* get_keys(void);

#endif // FEAL_H