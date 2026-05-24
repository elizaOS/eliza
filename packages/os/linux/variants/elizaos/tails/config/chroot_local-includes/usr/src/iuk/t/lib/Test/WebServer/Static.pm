package Test::WebServer::Static;

use strictures 2;
use Carp::Assert;

use parent qw{Test::WebServer};
use HTTP::Server::Simple::Static;

sub handle_request {
    my ($self, $cgi) = @_;
    return $self->serve_static($cgi, $self->{webroot});
}

1;
