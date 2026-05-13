import jax
import jax.numpy as jnp
import numpy as np


def load(path):
    if path.endswith(".npz"):
        return dict(np.load(path))
    return jnp.array(np.load(path))


def save(data, path):
    np.save(path, np.array(data))


def map_op(array, op):
    if op == "square":
        return jax.vmap(lambda x: x * x)(array)
    raise ValueError("Unknown op")


def reduce_op(array, op, axis):
    if op == "mean":
        return jnp.mean(array, axis=axis)
    raise ValueError("Unknown reduce op")


def logistic_grad(x, y, w):
    def loss(w):
        logits = x @ w
        return jnp.mean(jnp.logaddexp(0, -y * logits))

    return jax.grad(loss)(w)


def rnn_scan(seq, Wx, Wh, b):
    def step(h, x):
        h_new = jnp.tanh(Wx @ x + Wh @ h + b)
        return h_new, h_new

    h0 = jnp.zeros(Wh.shape[0])
    _, hseq = jax.lax.scan(step, h0, seq)
    return hseq


def jit_run(fn, args):
    return jax.jit(fn)(*args)
