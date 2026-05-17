=head1 NAME

Tails::Role::HasEncoding - role to provide an Encode::Encoding object for the codeset being used

=head1 SYNOPSIS

    package Tails::Daemon;
    use Moo;
    with 'Tails::Role::HasEncoding';
    sub foo {
       my $self = shift;
       $self->encoding->decode('bla');
    }

=cut

package Tails::Role::HasEncoding;

use 5.10.1;
use strictures 2;
use autodie qw(:all);

use Encode qw{find_encoding};
use Function::Parameters;

no Moo::sification;
use Moo::Role; # Moo::Role exports all methods declared after it's "use"'d

use namespace::clean;

has 'encoding' => (
    isa => sub {
        die "incorrect encoding type" unless
            ($_[0]->isa('Encode::Encoding') or $_[0]->isa('Encode::XS'))
    },
    is  => 'lazy',
);

method _build_encoding () {
    find_encoding('UTF-8');
}

no Moo::Role;
1; # End of Tails::Role::HasEncoding
