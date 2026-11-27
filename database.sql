-- Optional manual initialization. The app creates this table automatically when using Render Postgres.
CREATE TABLE IF NOT EXISTS public.oasis_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.oasis_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.oasis_state (id, state)
VALUES (
  1,
  '{
    "usuarios": [
      {"usuario":"admin","senha":"1234","tipo":"admin"},
      {"usuario":"triagem","senha":"1234","tipo":"triagem"},
      {"usuario":"medico","senha":"1234","tipo":"medico"},
      {"usuario":"atendimento","senha":"1234","tipo":"atendimento"},
      {"usuario":"tv","senha":"1234","tipo":"tv"},
      {"usuario":"medicacoes","senha":"1234","tipo":"medicacoes"},
      {"usuario":"almoxarifado","senha":"1234","tipo":"almoxarifado"}
    ],
    "pacientes": [],
    "triagens": [],
    "consultas": [],
    "chamadas": [],
    "estoque": [],
    "movimentacoesEstoque": []
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;