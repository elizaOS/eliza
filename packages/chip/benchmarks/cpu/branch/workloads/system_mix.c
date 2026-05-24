/*
 * system_mix.c - branch-behaviour proxies for broader CPU and GPU-control
 * workloads not covered by the agent_loop/io_stream traces.
 *
 * One mode per class, selected by argv[2]; argv[1] scales the workload:
 *   0 build    - token scanner + bytecode/CFG interpreter
 *   1 compress - LZ-style match search + Huffman-ish bit walk
 *   2 crypto   - packet auth/decrypt control with rare failures
 *   3 db       - B-tree lookup/update + small transaction state machine
 *   4 gpu      - command-buffer validation + fence/scheduler dispatch
 *   5 browser  - DOM/style/layout walk with event dispatch
 *   6 kernel   - syscall/file/socket scheduler control path
 *   7 gc       - mark/sweep/write-barrier runtime control path
 *   8 gpu_mem  - GPU residency/page-fault/descriptor-table control path
 *   9 gpu_irq  - GPU IRQ/fence scheduler and callback dispatch
 *  10 nn       - NN delegate graph executor with fallback/shape guards
 *  11 ui       - mobile frame scheduler, input, layout, composition phases
 *  12 wasm     - WASM/JIT tiering, OSR, deopt, and inline-cache churn
 *
 * The goal is not numerical fidelity. It is a deterministic RV64 branch trace
 * with realistic branch shapes: correlated parser states, indirect dispatch,
 * long loop nests, rare error exits, tree walks, and GPU driver/control-plane
 * phase changes.
 */

#include <stdint.h>
#include <stdio.h>

static uint64_t g_rng = 0xA5A5F00D12345678ull;
static inline uint32_t lcg(void) {
    g_rng = g_rng * 6364136223846793005ull + 1442695040888963407ull;
    return (uint32_t)(g_rng >> 32);
}

static int atoi_simple(const char *s) {
    int v = 0;
    while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    return v;
}

/* ===================== 0. compiler/build proxy ======================== */
enum { OP_LOAD, OP_ADD, OP_BRANCH, OP_CALL, OP_RET, OP_STORE, OP_MAX };
typedef int (*op_fn)(int, int);
static int op_load(int a, int b) { return a + (b & 255); }
static int op_add(int a, int b) { return a + b; }
static int op_branch(int a, int b) { return (b & 1) ? (a ^ b) : (a + 3); }
static int op_call(int a, int b) { return (a << 1) ^ (b * 17); }
static int op_ret(int a, int b) { return a - (b & 31); }
static int op_store(int a, int b) { return a ^ (b << 2); }
static op_fn ops[OP_MAX] = {op_load, op_add, op_branch, op_call, op_ret, op_store};

static int run_build(int units) {
    static uint8_t src[512];
    static uint8_t bytecode[256];
    int acc = 0;
    for (int u = 0; u < units; u++) {
        int n = 128 + (lcg() & 127);
        int phase = u & 7;
        for (int i = 0; i < n; i++) {
            uint32_t r = lcg();
            if ((i & 15) == 0) src[i] = (uint8_t)("{}();,+-*/"[phase % 9]);
            else if ((r & 7) == 0) src[i] = (uint8_t)('0' + (r % 10));
            else if ((r & 3) == 0) src[i] = (uint8_t)('a' + (r % 26));
            else src[i] = (uint8_t)" \n\t"[r % 3];
        }

        int bc = 0, depth = 0, ident = 0;
        for (int i = 0; i < n && bc < 256; i++) {
            uint8_t c = src[i];
            if (c >= 'a' && c <= 'z') {
                ident++;
                if ((ident & 3) == 0) bytecode[bc++] = OP_LOAD;
            } else if (c >= '0' && c <= '9') {
                bytecode[bc++] = OP_ADD;
            } else if (c == '{') {
                depth++;
                bytecode[bc++] = OP_CALL;
            } else if (c == '}') {
                if (depth > 0) depth--;
                bytecode[bc++] = OP_RET;
            } else if (c == '(' || c == ';') {
                bytecode[bc++] = OP_BRANCH;
            } else if (c == '+' || c == '*' || c == '-') {
                bytecode[bc++] = OP_STORE;
            }
        }

        for (int pc = 0; pc < bc; pc++) {
            int op = bytecode[pc] % OP_MAX;
            acc = ops[op](acc, pc + depth); /* indirect dispatch */
            if (op == OP_BRANCH && (acc & 3) == 0 && pc + 2 < bc) pc++;
            else if (op == OP_RET && depth == 0) acc ^= 0x55AA;
        }
    }
    return acc;
}

/* ===================== 1. compression proxy =========================== */
static int run_compress(int blocks) {
    static uint8_t in[1024];
    static uint16_t hist[256];
    int acc = 0;
    for (int b = 0; b < blocks; b++) {
        int n = 384 + (lcg() & 511);
        uint8_t seed = (uint8_t)(lcg() & 255);
        for (int i = 0; i < n; i++) {
            if ((i & 31) < 24) in[i] = (uint8_t)(seed + (i & 7));
            else in[i] = (uint8_t)(lcg() & 255);
        }
        for (int i = 0; i < 256; i++) hist[i] = 0;

        int pos = 0;
        while (pos < n) {
            uint8_t c = in[pos];
            int prev = hist[c];
            int best = 0;
            if (prev > 0 && prev < pos) {
                int max = (n - pos) < 18 ? (n - pos) : 18;
                for (int k = 0; k < max; k++) {
                    if (in[prev + k] == in[pos + k]) best++;
                    else break;
                }
            }
            hist[c] = (uint16_t)pos;
            if (best >= 3) {
                acc += best * 13;
                pos += best;
            } else {
                uint32_t bits = (uint32_t)c | (lcg() << 8);
                for (int k = 0; k < 8; k++) {
                    if (bits & (1u << k)) acc += k;
                    else acc -= k;
                }
                pos++;
            }
        }
    }
    return acc;
}

/* ===================== 2. crypto/control proxy ======================== */
static int run_crypto(int packets) {
    static uint32_t sbox[256];
    static uint8_t pkt[256];
    for (int i = 0; i < 256; i++) {
        sbox[i] = lcg() ^ ((uint32_t)i * 0x045d9f3bu);
    }
    uint32_t tag = 0xC001D00Du;
    int ok = 0, drop = 0;
    for (int p = 0; p < packets; p++) {
        int n = 64 + (lcg() & 127);
        int bad = (lcg() & 63) == 0;
        for (int i = 0; i < n; i++) pkt[i] = (uint8_t)(lcg() & 255);
        uint32_t a = tag ^ (uint32_t)n;
        for (int r = 0; r < 4; r++) {
            for (int i = 0; i < n; i++) {
                uint32_t x = sbox[(pkt[i] ^ (a >> 3)) & 255];
                a = (a << 5) | (a >> 27);
                a ^= x + (uint32_t)i;
                if ((a & 0x80000000u) && (i & 7) == 0) a ^= 0x9E3779B9u;
            }
        }
        if (bad) a ^= 1u;
        if ((a & 1u) == (tag & 1u)) ok++;
        else {
            drop++;
            if ((drop & 7) == 0) tag ^= a;
        }
    }
    return ok * 31 - drop;
}

/* ===================== 3. database/B-tree proxy ======================= */
#define DB_KEYS 256
static int keys[DB_KEYS];
static int vals[DB_KEYS];

static int run_db(int txns) {
    for (int i = 0; i < DB_KEYS; i++) {
        keys[i] = i * 8 + (int)(lcg() & 7);
        vals[i] = (int)lcg();
    }
    int acc = 0;
    for (int t = 0; t < txns; t++) {
        int k = (int)(lcg() % (DB_KEYS * 8));
        int lo = 0, hi = DB_KEYS - 1, found = -1;
        while (lo <= hi) {
            int mid = (lo + hi) >> 1;
            if (keys[mid] == k) { found = mid; break; }
            if (keys[mid] < k) lo = mid + 1;
            else hi = mid - 1;
        }
        int op = (t + (int)(lcg() & 3)) & 3;
        switch (op) {
        case 0: /* point read */
            if (found >= 0) acc ^= vals[found];
            else acc += lo;
            break;
        case 1: /* update existing or nearest slot */
            if (found >= 0) vals[found] ^= acc + k;
            else vals[lo & (DB_KEYS - 1)] += k;
            break;
        case 2: /* range scan */
            for (int i = lo; i < DB_KEYS && i < lo + 12; i++) {
                if ((keys[i] ^ k) & 1) acc += vals[i];
                else acc -= vals[i];
            }
            break;
        default: /* transaction outcome */
            if ((acc & 15) == 0) acc ^= 0xBAD5EED;
            else if ((acc & 3) == 0) acc += t;
            else acc -= k;
            break;
        }
    }
    return acc;
}

/* ===================== 4. GPU driver/control proxy ==================== */
enum { CMD_BIND, CMD_DRAW, CMD_DISPATCH, CMD_BARRIER, CMD_WAIT, CMD_SIGNAL, CMD_MAX };
static int run_gpu(int submits) {
    static uint8_t cmds[512];
    int acc = 0, fence = 0, queue = 0;
    for (int s = 0; s < submits; s++) {
        int n = 64 + (lcg() & 127);
        int phase = s & 3;
        for (int i = 0; i < n; i++) {
            if (phase == 0) cmds[i] = (i & 7) == 0 ? CMD_BIND : CMD_DRAW;
            else if (phase == 1) cmds[i] = (i & 3) == 0 ? CMD_BARRIER : CMD_DISPATCH;
            else if (phase == 2) cmds[i] = (i & 15) == 0 ? CMD_WAIT : CMD_DRAW;
            else cmds[i] = (uint8_t)(lcg() % CMD_MAX);
        }
        for (int i = 0; i < n; i++) {
            switch (cmds[i]) {
            case CMD_BIND:
                queue ^= i + s;
                acc += 3;
                break;
            case CMD_DRAW:
                if ((queue & 7) == 0) acc += 11;
                else acc += 5;
                break;
            case CMD_DISPATCH:
                if ((i ^ s) & 1) acc ^= 0x1234;
                else acc += queue;
                break;
            case CMD_BARRIER:
                fence++;
                if ((fence & 3) == 0) queue = 0;
                break;
            case CMD_WAIT:
                if (fence > 0) fence--;
                else acc -= 17;
                break;
            case CMD_SIGNAL:
                fence += 2;
                break;
            default:
                acc ^= 0xDEAD;
                break;
            }
        }
    }
    return acc ^ fence ^ queue;
}

/* ===================== 5. browser/layout proxy ======================== */
#define DOM_NODES 192
enum { NODE_DIV, NODE_TEXT, NODE_IMG, NODE_INPUT, NODE_CANVAS, NODE_MAX };
enum { EV_CLICK, EV_KEY, EV_TIMER, EV_NET, EV_MAX };

static int run_browser(int frames) {
    static uint8_t node_type[DOM_NODES];
    static int parent[DOM_NODES];
    static int style[DOM_NODES];
    static int layout[DOM_NODES];
    int acc = 0;
    for (int i = 0; i < DOM_NODES; i++) {
        node_type[i] = (uint8_t)(lcg() % NODE_MAX);
        parent[i] = (i == 0) ? -1 : (int)(lcg() % i);
        style[i] = (int)(lcg() & 255);
        layout[i] = 0;
    }
    for (int f = 0; f < frames; f++) {
        int dirty = (int)(lcg() % DOM_NODES);
        int event = (f + (int)(lcg() & 3)) % EV_MAX;
        switch (event) {
        case EV_CLICK:
            style[dirty] ^= 0x11;
            break;
        case EV_KEY:
            style[dirty] += 3;
            if (node_type[dirty] == NODE_INPUT) acc += dirty;
            break;
        case EV_TIMER:
            for (int i = dirty; i < DOM_NODES; i += 17) style[i] ^= f;
            break;
        case EV_NET:
            node_type[dirty] = (uint8_t)(lcg() % NODE_MAX);
            break;
        }

        for (int i = 0; i < DOM_NODES; i++) {
            int inherited = parent[i] >= 0 ? style[parent[i]] : 0;
            int s = style[i] ^ inherited;
            if (node_type[i] == NODE_TEXT) s += 7;
            else if (node_type[i] == NODE_IMG) s += 13;
            else if (node_type[i] == NODE_CANVAS) s ^= 0x40;
            style[i] = s & 255;
        }
        for (int i = 0; i < DOM_NODES; i++) {
            int w = 8 + (style[i] & 31);
            int h = 8 + ((style[i] >> 3) & 31);
            if (node_type[i] == NODE_TEXT) w += (i & 15);
            else if (node_type[i] == NODE_IMG) h += 16;
            else if (node_type[i] == NODE_INPUT && (style[i] & 1)) w += 24;
            layout[i] = w * h;
            if ((layout[i] ^ f) & 7) acc += layout[i];
            else acc -= layout[i];
        }
    }
    return acc;
}

/* ===================== 6. kernel/syscall proxy ======================== */
enum { SYS_READ, SYS_WRITE, SYS_POLL, SYS_IOCTL, SYS_FUTEX, SYS_MMAP, SYS_MAX };

static int run_kernel(int calls) {
    static int fd_state[64];
    static int runq[128];
    int acc = 0, rq_head = 0, rq_tail = 0;
    for (int i = 0; i < 64; i++) fd_state[i] = (int)(lcg() & 7);
    for (int c = 0; c < calls; c++) {
        int sys = (c + (int)(lcg() & 7)) % SYS_MAX;
        int fd = (int)(lcg() & 63);
        switch (sys) {
        case SYS_READ:
            if (fd_state[fd] & 1) acc += fd_state[fd];
            else acc -= fd;
            break;
        case SYS_WRITE:
            if (fd_state[fd] & 2) fd_state[fd] ^= c;
            else fd_state[fd] += 1;
            break;
        case SYS_POLL:
            for (int i = 0; i < 16; i++) {
                int f = (fd + i * 3) & 63;
                if (fd_state[f] & 4) runq[rq_tail++ & 127] = f;
            }
            break;
        case SYS_IOCTL:
            if ((fd_state[fd] ^ c) & 8) acc ^= 0x1021;
            else acc += fd * 5;
            break;
        case SYS_FUTEX:
            if (rq_head != rq_tail) acc += runq[rq_head++ & 127];
            else runq[rq_tail++ & 127] = fd;
            break;
        case SYS_MMAP:
            for (int p = 0; p < 8; p++) {
                if ((lcg() >> p) & 1) acc += p + fd;
                else acc -= p;
            }
            break;
        }
        if ((c & 31) == 0 && rq_head != rq_tail) acc ^= runq[rq_head++ & 127];
    }
    return acc ^ rq_head ^ rq_tail;
}

/* ===================== 7. GC/runtime proxy ============================ */
#define HEAP_OBJS 256
static uint8_t obj_mark[HEAP_OBJS];
static uint8_t obj_gen[HEAP_OBJS];
static uint16_t obj_ref0[HEAP_OBJS];
static uint16_t obj_ref1[HEAP_OBJS];

static int run_gc(int cycles) {
    int acc = 0;
    for (int i = 0; i < HEAP_OBJS; i++) {
        obj_mark[i] = 0;
        obj_gen[i] = (uint8_t)(lcg() & 3);
        obj_ref0[i] = (uint16_t)(lcg() % HEAP_OBJS);
        obj_ref1[i] = (uint16_t)(lcg() % HEAP_OBJS);
    }
    for (int c = 0; c < cycles; c++) {
        int alloc = (int)(lcg() % HEAP_OBJS);
        obj_gen[alloc] = 0;
        obj_ref0[alloc] = (uint16_t)(lcg() % HEAP_OBJS);
        obj_ref1[alloc] = (uint16_t)(lcg() % HEAP_OBJS);
        if (obj_gen[obj_ref0[alloc]] > obj_gen[alloc]) acc += alloc; /* barrier */

        if ((c & 7) == 0) {
            static uint16_t stack[HEAP_OBJS];
            int sp = 0;
            for (int r = 0; r < 8; r++) stack[sp++] = (uint16_t)((c * 17 + r * 23) % HEAP_OBJS);
            while (sp > 0) {
                int o = stack[--sp];
                if (obj_mark[o]) continue;
                obj_mark[o] = 1;
                if (obj_gen[o] < 3) obj_gen[o]++;
                if (sp + 2 < HEAP_OBJS) {
                    if ((obj_ref0[o] ^ c) & 1) stack[sp++] = obj_ref0[o];
                    if ((obj_ref1[o] ^ c) & 2) stack[sp++] = obj_ref1[o];
                }
            }
            for (int i = 0; i < HEAP_OBJS; i++) {
                if (obj_mark[i]) {
                    obj_mark[i] = 0;
                    acc += obj_gen[i];
                } else {
                    obj_gen[i] = 0;
                    obj_ref0[i] = (uint16_t)(lcg() % HEAP_OBJS);
                    obj_ref1[i] = (uint16_t)(lcg() % HEAP_OBJS);
                    acc -= i & 7;
                }
            }
        }
    }
    return acc;
}

/* ===================== 8. GPU residency/page-fault proxy ============== */
#define GPU_PAGES 512
#define GPU_DESCS 192
static int run_gpu_residency(int batches) {
    static uint8_t resident[GPU_PAGES];
    static uint8_t dirty[GPU_PAGES];
    static uint16_t desc_page[GPU_DESCS];
    int acc = 0, faults = 0, evicts = 0;
    for (int p = 0; p < GPU_PAGES; p++) {
        resident[p] = (uint8_t)((p & 7) != 0);
        dirty[p] = (uint8_t)(p & 1);
    }
    for (int d = 0; d < GPU_DESCS; d++) desc_page[d] = (uint16_t)((d * 17) & (GPU_PAGES - 1));

    for (int b = 0; b < batches; b++) {
        int burst = 24 + (lcg() & 31);
        int phase = b & 3;
        for (int i = 0; i < burst; i++) {
            int d = (i * 13 + b * 7 + (int)(lcg() & 15)) % GPU_DESCS;
            int page = desc_page[d];
            if (phase == 1 && (i & 7) == 0) page = (page + 97) & (GPU_PAGES - 1);
            if (!resident[page]) {
                faults++;
                resident[page] = 1;
                dirty[page] = 0;
                acc -= page & 31;
            } else if (dirty[page]) {
                acc += page ^ d;
                if ((acc & 15) == 0) dirty[page] = 0;
            } else {
                acc += d;
                if (((b + i) & 11) == 0) dirty[page] = 1;
            }
            if ((phase == 2) && ((i + faults) & 15) == 0) {
                int victim = (page + 131 + evicts) & (GPU_PAGES - 1);
                if (resident[victim] && !dirty[victim]) {
                    resident[victim] = 0;
                    evicts++;
                } else {
                    acc ^= victim;
                }
            }
            desc_page[d] = (uint16_t)((page + (acc & 3)) & (GPU_PAGES - 1));
        }
    }
    return acc ^ (faults << 4) ^ evicts;
}

/* ===================== 9. GPU IRQ/fence scheduler proxy =============== */
enum { GPU_CB_SIGNAL, GPU_CB_TIMEOUT, GPU_CB_SUBMIT, GPU_CB_RETIRE, GPU_CB_MAX };
typedef int (*gpu_cb_fn)(int, int);
static int cb_signal(int a, int b) { return a + b + 3; }
static int cb_timeout(int a, int b) { return a - (b * 5); }
static int cb_submit(int a, int b) { return (a ^ (b << 2)) + 11; }
static int cb_retire(int a, int b) { return a + ((b & 7) ? 17 : -13); }
static gpu_cb_fn gpu_callbacks[GPU_CB_MAX] = {
    cb_signal, cb_timeout, cb_submit, cb_retire
};

static int run_gpu_irq_fence(int ticks) {
    static uint16_t fence_q[256];
    static uint8_t kind_q[256];
    int head = 0, tail = 0, next_fence = 1, acc = 0;
    for (int t = 0; t < ticks; t++) {
        int arrivals = 1 + ((lcg() >> 3) & 3);
        for (int a = 0; a < arrivals; a++) {
            int slot = tail++ & 255;
            fence_q[slot] = (uint16_t)(next_fence + ((lcg() & 7) == 0 ? 7 : 0));
            kind_q[slot] = (uint8_t)((t + a + (int)(lcg() & 3)) % GPU_CB_MAX);
            next_fence++;
        }
        int budget = 1 + (t & 3);
        while (budget-- > 0 && head != tail) {
            int slot = head & 255;
            int ready = ((fence_q[slot] <= next_fence) || ((t ^ fence_q[slot]) & 31) == 0);
            if (!ready) {
                if ((t & 15) == 0) {
                    kind_q[slot] = GPU_CB_TIMEOUT;
                    ready = 1;
                } else {
                    break;
                }
            }
            acc = gpu_callbacks[kind_q[slot] % GPU_CB_MAX](acc, fence_q[slot]);
            head++;
            if ((acc & 63) == 0) {
                int retry = tail++ & 255;
                fence_q[retry] = (uint16_t)(next_fence + 3);
                kind_q[retry] = GPU_CB_SUBMIT;
            }
        }
    }
    return acc ^ head ^ tail;
}

/* ===================== 10. NN delegate/fallback proxy ================= */
enum { OP_CONV, OP_GEMM, OP_RELU, OP_RESHAPE, OP_SOFTMAX, OP_CUSTOM, NN_OP_MAX };
static int run_nn_delegate(int graphs) {
    static uint8_t op[256];
    static uint8_t rank[256];
    static uint8_t supported[NN_OP_MAX] = {1, 1, 1, 1, 0, 0};
    int acc = 0, fallback = 0;
    for (int g = 0; g < graphs; g++) {
        int n = 48 + (lcg() & 63);
        int dynamic_shape = ((g ^ (int)lcg()) & 7) == 0;
        for (int i = 0; i < n; i++) {
            uint32_t r = lcg();
            op[i] = (uint8_t)((i + (r & 3) + (dynamic_shape ? 2 : 0)) % NN_OP_MAX);
            rank[i] = (uint8_t)(1 + ((r >> 8) & 3));
        }
        for (int i = 0; i < n; i++) {
            int o = op[i];
            int ok = supported[o] && !(dynamic_shape && o == OP_RESHAPE && (i & 3));
            if (ok) {
                if (o == OP_CONV || o == OP_GEMM) acc += rank[i] * 17;
                else if (o == OP_RELU) acc += 3;
                else acc += i & 7;
            } else {
                fallback++;
                for (int k = 0; k < rank[i] + 2; k++) {
                    if ((fallback + k + i) & 1) acc -= k + o;
                    else acc ^= (o << k);
                }
                if ((fallback & 15) == 0) supported[OP_SOFTMAX] = 1;
            }
            if ((i & 15) == 0 && (acc & 3) == 0) supported[OP_CUSTOM] ^= 1;
        }
    }
    return acc ^ (fallback << 5);
}

/* ===================== 11. Mobile UI frame scheduler proxy ============ */
enum { UI_INPUT, UI_ANIMATE, UI_LAYOUT, UI_COMPOSE, UI_GPU_WAIT, UI_MAX };
static int run_mobile_ui(int frames) {
    static uint8_t queue[256];
    int head = 0, tail = 0, missed = 0, acc = 0;
    for (int f = 0; f < frames; f++) {
        int events = 2 + (lcg() & 7);
        for (int e = 0; e < events; e++) queue[tail++ & 255] = (uint8_t)((e + f + (lcg() & 3)) % UI_MAX);
        int budget = 16;
        while (budget > 0 && head != tail) {
            int ev = queue[head++ & 255];
            switch (ev) {
            case UI_INPUT:
                budget -= 2;
                acc += f & 31;
                if ((acc & 7) == 0) queue[tail++ & 255] = UI_LAYOUT;
                break;
            case UI_ANIMATE:
                budget -= 1 + (acc & 3);
                acc ^= 0x51;
                break;
            case UI_LAYOUT:
                budget -= 5;
                for (int n = 0; n < 12; n++) {
                    if (((n * f + acc) & 5) == 0) acc += n;
                    else acc -= n & 3;
                }
                queue[tail++ & 255] = UI_COMPOSE;
                break;
            case UI_COMPOSE:
                budget -= 4;
                acc += tail - head;
                if ((lcg() & 15) == 0) queue[tail++ & 255] = UI_GPU_WAIT;
                break;
            case UI_GPU_WAIT:
                budget -= 6;
                if ((f + acc) & 3) acc -= 19;
                else acc += 23;
                break;
            }
        }
        if (budget <= 0 || ((tail - head) > 96)) {
            missed++;
            if ((missed & 3) == 0) head = tail - 24;
        }
    }
    return acc ^ (missed << 8);
}

/* ===================== 12. WASM/JIT tiering proxy ===================== */
enum { IC_MONO, IC_POLY, IC_MEGA, IC_MISS };
static int run_wasm_jit(int calls) {
    static uint8_t tier[128];
    static uint8_t ic_state[128];
    int acc = 0, deopts = 0;
    for (int i = 0; i < 128; i++) {
        tier[i] = (uint8_t)(i & 1);
        ic_state[i] = IC_MONO;
    }
    for (int c = 0; c < calls; c++) {
        int fn = (c * 13 + (int)(lcg() & 31)) & 127;
        int shape = (int)((lcg() >> 4) & 7);
        if (tier[fn] == 0) {
            acc += fn;
            if ((c & 15) == 0) tier[fn] = 1;
        } else {
            switch (ic_state[fn]) {
            case IC_MONO:
                if (shape == (fn & 7)) acc += shape * 3;
                else ic_state[fn] = IC_POLY;
                break;
            case IC_POLY:
                if ((shape ^ fn) & 1) acc += 11;
                else ic_state[fn] = IC_MEGA;
                break;
            case IC_MEGA:
                acc += (shape * fn) & 31;
                if ((lcg() & 31) == 0) ic_state[fn] = IC_MISS;
                break;
            default:
                deopts++;
                tier[fn] = 0;
                ic_state[fn] = IC_MONO;
                acc -= fn;
                break;
            }
            if ((acc & 127) == 0) {
                deopts++;
                tier[fn] = 0;
            }
        }
    }
    return acc ^ (deopts << 3);
}

int main(int argc, char **argv) {
    int scale = (argc > 1) ? atoi_simple(argv[1]) : 1000;
    int mode = (argc > 2) ? atoi_simple(argv[2]) : 0;
    int out;
    switch (mode) {
    case 0: out = run_build(scale); break;
    case 1: out = run_compress(scale); break;
    case 2: out = run_crypto(scale); break;
    case 3: out = run_db(scale); break;
    case 4: out = run_gpu(scale); break;
    case 5: out = run_browser(scale); break;
    case 6: out = run_kernel(scale); break;
    case 7: out = run_gc(scale); break;
    case 8: out = run_gpu_residency(scale); break;
    case 9: out = run_gpu_irq_fence(scale); break;
    case 10: out = run_nn_delegate(scale); break;
    case 11: out = run_mobile_ui(scale); break;
    case 12: out = run_wasm_jit(scale); break;
    default: out = run_build(scale); break;
    }
    printf("mode=%d out=%d\n", mode, out);
    return 0;
}
