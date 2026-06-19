use crate::probability::Prob;

pub trait EncoderInterface {
    fn encode_bit(&mut self, bit: bool, prob: Prob);
    fn encode_direct_bits(&mut self, bits: u32, num_bits: u32);
}
