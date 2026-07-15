const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Recipe-Key",
  "Access-Control-Allow-Methods": "GET, OPTIONS, PUT"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method === "GET") return getRecipes(env);
    if (request.method === "PUT") return updateRecipes(request, env);
    return json({ error: "Method not allowed" }, 405);
  }
};

async function getRecipes(env) {
  const response = await githubRequest(env, `contents/${env.RECIPE_PATH}`);
  if (!response.ok) return githubError(response, "Could not read recipes");
  const file = await response.json();
  const recipes = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (character) => character.charCodeAt(0))));
  return json({ recipes });
}

async function updateRecipes(request, env) {
  if (!env.RECIPE_WRITE_KEY || request.headers.get("X-Recipe-Key") !== env.RECIPE_WRITE_KEY) {
    return json({ error: "Invalid recipe write key" }, 401);
  }

  const payload = await request.json();
  if (!Array.isArray(payload.recipes)) return json({ error: "recipes must be an array" }, 400);

  const currentResponse = await githubRequest(env, `contents/${env.RECIPE_PATH}`);
  if (!currentResponse.ok) return githubError(currentResponse, "Could not read current recipes");
  const currentFile = await currentResponse.json();
  const content = `${JSON.stringify(payload.recipes, null, 2)}\n`;
  const updateResponse = await githubRequest(env, `contents/${env.RECIPE_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update recipes",
      content: encodeBase64(content),
      sha: currentFile.sha,
      branch: env.GITHUB_BRANCH || "main"
    })
  });

  if (updateResponse.status === 409) return json({ error: "Recipes changed elsewhere. Reload and try again." }, 409);
  if (!updateResponse.ok) return githubError(updateResponse, "Could not save recipes");
  return json({ saved: true });
}

function githubRequest(env, path, options = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "recipe-book-worker",
      ...(options.headers || {})
    }
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function githubError(response, fallback) {
  let detail = fallback;
  try {
    const payload = await response.json();
    if (payload.message) detail = payload.message;
  } catch (error) {
    // Keep the fallback when GitHub does not return JSON.
  }
  return json({ error: detail, githubStatus: response.status }, response.status >= 500 ? 502 : response.status);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}